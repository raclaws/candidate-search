"""
Signal Engine Recompute Worker.

Keeps candidate_signals table fresh in interview-general's SQLite DB.

Usage:
  python recompute.py --full              Full recompute (all candidates)
  python recompute.py --incremental <id>  Position one candidate against existing distributions
  python recompute.py --watch             Poll for changes, auto-recompute

Writes to interview-general's interview.db via raw sqlite3 (no SQLModel dependency).
"""

import argparse
import json
import os
import pickle
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

from signal_engine import run_engine, build_signal_map, normalize_salary, DistributionStore, process_candidate, compute_years_band
from cv_parser import parse_cv
from credibility_layer import detect_employment_status
from company_extractor import extract_companies_from_cv, CANONICAL_NAMES

CACHE_DIR = Path(__file__).parent / "cv_cache"
DB_PATH = os.getenv("SIGNAL_DB_PATH", str(Path(__file__).parent.parent / "interview-general" / "interview.db"))
DIST_PICKLE = Path(__file__).parent / ".dist_store.pkl"

WATCH_SOURCES = [
    Path(__file__).parent / "signal_engine.py",
    Path(__file__).parent / "cv_parser.py",
    Path(__file__).parent / "company_extractor.py",
    Path(__file__).parent / "credibility_layer.py",
    Path(__file__).parent / "categorize_companies.py",
    CACHE_DIR / "companies_categorized.json",
]

CATEGORY_MAP_PATH = CACHE_DIR / "companies_categorized.json"

UPSERT_SQL = """
INSERT INTO candidate_signals (
    candidate_id, nocodb_id, salary_label, percentile, comparison_source,
    bucket_size, role_bucket, gate_status, flag_count, flags_json,
    skills_explicit, skills_contextual, domains, companies, company_category,
    company_confidence, credentials, latest_role, total_years, years_band,
    trajectory, employment_status, computed_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(candidate_id) DO UPDATE SET
    nocodb_id=excluded.nocodb_id,
    salary_label=excluded.salary_label,
    percentile=excluded.percentile,
    comparison_source=excluded.comparison_source,
    bucket_size=excluded.bucket_size,
    role_bucket=excluded.role_bucket,
    gate_status=excluded.gate_status,
    flag_count=excluded.flag_count,
    flags_json=excluded.flags_json,
    skills_explicit=excluded.skills_explicit,
    skills_contextual=excluded.skills_contextual,
    domains=excluded.domains,
    companies=excluded.companies,
    company_category=excluded.company_category,
    company_confidence=excluded.company_confidence,
    credentials=excluded.credentials,
    latest_role=excluded.latest_role,
    total_years=excluded.total_years,
    years_band=excluded.years_band,
    trajectory=excluded.trajectory,
    employment_status=excluded.employment_status,
    computed_at=excluded.computed_at
"""


def load_records():
    path = CACHE_DIR / "all_records.json"
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_cv_texts(records=None):
    texts = {}
    if records:
        for r in records:
            rid = r.get("id", r.get("Id"))
            p = CACHE_DIR / f"{rid}.txt"
            if p.exists():
                texts[rid] = p.read_text(encoding="utf-8", errors="replace")
    else:
        for p in CACHE_DIR.glob("*.txt"):
            try:
                rid = int(p.stem)
                texts[rid] = p.read_text(encoding="utf-8", errors="replace")
            except ValueError:
                continue
    return texts


def load_category_map():
    if not CATEGORY_MAP_PATH.exists():
        return {}
    with open(CATEGORY_MAP_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    return {item["name"]: item["category"] for item in data}


def resolve_company_category(cv_text: str, category_map: dict) -> tuple[str, str]:
    """Returns (category, confidence). A-path = 'matched', B-path = 'inferred'."""
    if not cv_text:
        return "", ""
    from cv_parser import extract_timeline
    timeline = extract_timeline(cv_text)
    if not timeline:
        return "", ""
    latest_org = timeline[0].org
    if latest_org == "Unknown Org":
        return "", ""

    # A-path: exact match against categorized companies
    for company_name, category in category_map.items():
        if company_name.lower() in latest_org.lower() or latest_org.lower() in company_name.lower():
            return category, "matched"

    # B-path: canonical name lookup
    org_lower = latest_org.lower()
    for key, canonical in CANONICAL_NAMES.items():
        if key in org_lower:
            cat = category_map.get(canonical, "")
            if cat:
                return cat, "inferred"

    return "", ""


def get_nocodb_candidate_map(db_path: str) -> dict[int, int]:
    """Map nocodb_id → candidate_id from interview-general's candidates table."""
    conn = sqlite3.connect(db_path)
    rows = conn.execute("SELECT id, nocodb_id FROM candidates WHERE nocodb_id IS NOT NULL").fetchall()
    conn.close()
    return {nocodb_id: cid for cid, nocodb_id in rows}


def build_row(candidate_id: int, nocodb_id: int, output, cv_signals, category: str, confidence: str, emp_status: str, years_band_val: str):
    skills_explicit = ",".join(sorted(cv_signals.skills_explicit)) if cv_signals else ""
    skills_contextual = ",".join(sorted(cv_signals.skills_contextual - cv_signals.skills_explicit)) if cv_signals else ""
    domains = ",".join(sorted(cv_signals.domains)) if cv_signals else ""
    credentials = ",".join(c.institution.split(",")[0].strip()[:50] for c in (cv_signals.credentials[:5] if cv_signals else []))
    companies_str = ",".join(e.org for e in (cv_signals.timeline[:10] if cv_signals else []) if e.org != "Unknown Org")
    latest_role = (cv_signals.latest_role if cv_signals else "") or ""
    total_years = cv_signals.total_years if cv_signals else None
    trajectory = (cv_signals.title_trajectory if cv_signals else "") or ""

    flags_data = [{"pattern": f.pattern, "a": f.interpretation_a, "b": f.interpretation_b} for f in output.flags]

    return (
        candidate_id,
        nocodb_id,
        output.salary_label.value or "",
        output.percentile,
        output._comparison_source or "",
        output._bucket_size or 0,
        output.role_bucket or "",
        output.gate_status.value or "",
        len(output.flags),
        json.dumps(flags_data),
        skills_explicit or "",
        skills_contextual or "",
        domains or "",
        companies_str or "",
        category or "",
        confidence or "",
        credentials or "",
        latest_role or "",
        total_years,
        years_band_val or "",
        trajectory or "",
        emp_status or "",
        datetime.now(timezone.utc).isoformat(),
    )


def full_recompute():
    print("=== Full Recompute ===")
    records = load_records()
    print(f"  {len(records)} records loaded")

    cv_texts = load_cv_texts(records)
    print(f"  {len(cv_texts)} CV texts")

    category_map = load_category_map()
    print(f"  {len(category_map)} companies in category map")

    # Resolve categories per candidate (with confidence)
    categories = {}
    confidences = {}
    for r in records:
        rid = r.get("id", r.get("Id"))
        cv = cv_texts.get(rid, "")
        cat, conf = resolve_company_category(cv, category_map)
        if cat:
            categories[rid] = cat
            confidences[rid] = conf

    print(f"  {len(categories)} candidates with company category ({sum(1 for v in confidences.values() if v == 'matched')} matched, {sum(1 for v in confidences.values() if v == 'inferred')} inferred)")

    # Only pass A-path (matched) categories to distribution ingestion
    ingestion_categories = {rid: cat for rid, cat in categories.items() if confidences.get(rid) == "matched"}

    # Run signal engine
    print("  Running signal engine...")
    outputs, store = run_engine(records, cv_texts=cv_texts, company_categories=ingestion_categories)
    print(f"  {len(outputs)} outputs")

    # Save distribution store for incremental use
    with open(DIST_PICKLE, "wb") as f:
        pickle.dump(store, f)
    print(f"  Distribution store saved to {DIST_PICKLE}")

    # Parse CVs
    print("  Parsing CVs...")
    cv_parsed = {}
    for rid, text in cv_texts.items():
        cv_parsed[rid] = parse_cv(text)

    # Get candidate_id mapping
    nocodb_map = get_nocodb_candidate_map(DB_PATH)
    print(f"  {len(nocodb_map)} candidates with nocodb_id in interview.db")

    # Write to SQLite
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    matched = 0

    for i, record in enumerate(records):
        rid = record.get("id", record.get("Id"))
        if rid not in nocodb_map:
            continue

        candidate_id = nocodb_map[rid]
        output = outputs[i]
        cv_sig = cv_parsed.get(rid)

        # Employment status
        f = record.get("fields", record)
        title_raw = f.get("Current Formal Positions", "")
        salary_signal = normalize_salary(f.get("(Full-time) Current Salary (Nett in IDR)", ""))
        salary_val = salary_signal.value if salary_signal.value else None
        emp_status = detect_employment_status(title_raw, salary_val).value

        # Years band
        years_raw = f.get("Total Years of Experience", "")
        yb = ""
        try:
            yv = float(years_raw)
            yb = compute_years_band(yv)
        except (ValueError, TypeError):
            pass

        cat = categories.get(rid, "")
        conf = confidences.get(rid, "")

        row = build_row(candidate_id, rid, output, cv_sig, cat, conf, emp_status, yb)
        conn.execute(UPSERT_SQL, row)
        matched += 1

    conn.commit()
    conn.close()
    print(f"  {matched} rows upserted")
    print("=== Done ===")
    return matched


def incremental_recompute(nocodb_id: int):
    print(f"=== Incremental: nocodb_id={nocodb_id} ===")

    if not DIST_PICKLE.exists():
        print("  No distribution store found — running full recompute first")
        full_recompute()
        return

    with open(DIST_PICKLE, "rb") as f:
        store = pickle.load(f)

    nocodb_map = get_nocodb_candidate_map(DB_PATH)
    if nocodb_id not in nocodb_map:
        print(f"  nocodb_id {nocodb_id} not found in candidates table — skipping")
        return

    candidate_id = nocodb_map[nocodb_id]
    category_map = load_category_map()

    # Load record
    records = load_records()
    record = next((r for r in records if r.get("id", r.get("Id")) == nocodb_id), None)
    if not record:
        print(f"  Record {nocodb_id} not in all_records.json — skipping")
        return

    # Load CV
    cv_path = CACHE_DIR / f"{nocodb_id}.txt"
    cv_text = cv_path.read_text(encoding="utf-8", errors="replace") if cv_path.exists() else ""

    # Company category
    cat, conf = resolve_company_category(cv_text, category_map)
    ingestion_cat = cat if conf == "matched" else None

    # Process against existing distributions
    output = process_candidate(record, store, cv_text=cv_text, company_category=ingestion_cat)

    # Parse CV
    cv_sig = parse_cv(cv_text) if cv_text else None

    # Employment status
    f = record.get("fields", record)
    title_raw = f.get("Current Formal Positions", "")
    salary_signal = normalize_salary(f.get("(Full-time) Current Salary (Nett in IDR)", ""))
    salary_val = salary_signal.value if salary_signal.value else None
    emp_status = detect_employment_status(title_raw, salary_val).value

    # Years band
    years_raw = f.get("Total Years of Experience", "")
    yb = ""
    try:
        yv = float(years_raw)
        yb = compute_years_band(yv)
    except (ValueError, TypeError):
        pass

    row = build_row(candidate_id, nocodb_id, output, cv_sig, cat, conf, emp_status, yb)

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(UPSERT_SQL, row)
    conn.commit()
    conn.close()
    print(f"  Updated candidate_id={candidate_id}")
    print("=== Done ===")


def watch_mode():
    print(f"=== Watch Mode (DB: {DB_PATH}) ===")
    print("  Running initial full recompute...")
    full_recompute()

    # Track mtimes
    source_mtimes = {}
    for src in WATCH_SOURCES:
        if src.exists():
            source_mtimes[src] = src.stat().st_mtime

    known_cvs = set(int(p.stem) for p in CACHE_DIR.glob("*.txt") if p.stem.isdigit())
    print(f"  Watching {len(WATCH_SOURCES)} source files + {len(known_cvs)} CVs")
    print("  Poll interval: 30s")

    while True:
        time.sleep(30)

        # Check source file changes → full recompute
        need_full = False
        for src in WATCH_SOURCES:
            if src.exists():
                mtime = src.stat().st_mtime
                if src not in source_mtimes or mtime > source_mtimes[src]:
                    print(f"  [change] {src.name} modified → full recompute")
                    source_mtimes[src] = mtime
                    need_full = True

        if need_full:
            full_recompute()
            known_cvs = set(int(p.stem) for p in CACHE_DIR.glob("*.txt") if p.stem.isdigit())
            continue

        # Check for new CV files → incremental
        current_cvs = set(int(p.stem) for p in CACHE_DIR.glob("*.txt") if p.stem.isdigit())
        new_cvs = current_cvs - known_cvs
        if new_cvs:
            print(f"  [new] {len(new_cvs)} new CV(s) detected")
            for rid in new_cvs:
                incremental_recompute(rid)
            known_cvs = current_cvs


def export_benchmark_json(output_path: str):
    """Export distribution stats as JSON for the static benchmark page."""
    import statistics as stats_mod
    from collections import defaultdict

    print(f"=== Export Benchmark JSON > {output_path} ===")
    records = load_records()
    cv_texts = load_cv_texts(records)
    category_map = load_category_map()

    categories = {}
    confidences = {}
    for r in records:
        rid = r.get("id", r.get("Id"))
        cv = cv_texts.get(rid, "")
        cat, conf = resolve_company_category(cv, category_map)
        if cat:
            categories[rid] = cat
            confidences[rid] = conf

    ingestion_categories = {rid: cat for rid, cat in categories.items() if confidences.get(rid) == "matched"}
    outputs, store = run_engine(records, cv_texts=cv_texts, company_categories=ingestion_categories)

    buckets = defaultdict(lambda: {"percentiles": [], "labels": defaultdict(int), "categories": defaultdict(int)})

    for i, record in enumerate(records):
        rid = record.get("id", record.get("Id"))
        output = outputs[i]
        if output.salary_label.value in ("NO_INPUT", "INSUFFICIENT_DATA", "INVALID", ""):
            continue
        if output.role_bucket in ("UNKNOWN", ""):
            continue

        f = record.get("fields", record)
        years_raw = f.get("Total Years of Experience", "")
        yb = ""
        try:
            yb = compute_years_band(float(years_raw))
        except (ValueError, TypeError):
            continue

        key = (output.role_bucket, yb)
        buckets[key]["percentiles"].append(output.percentile or 0)
        buckets[key]["labels"][output.salary_label.value] += 1
        cat = categories.get(rid, "")
        if cat:
            buckets[key]["categories"][cat] += 1

    results = []
    for (role, band), data in sorted(buckets.items()):
        pcts = data["percentiles"]
        entry = {
            "role": role,
            "band": band,
            "count": len(pcts),
            "p25": round(stats_mod.quantiles(pcts, n=4)[0], 1) if len(pcts) >= 4 else None,
            "p50": round(stats_mod.median(pcts), 1) if pcts else None,
            "p75": round(stats_mod.quantiles(pcts, n=4)[2], 1) if len(pcts) >= 4 else None,
            "distribution": dict(data["labels"]),
            "categories": dict(data["categories"]),
        }
        results.append(entry)

    roles = sorted(set(r["role"] for r in results))
    bands = ["0-1yr", "1-3yr", "3-5yr", "5-8yr", "8yr+"]

    out = {"buckets": results, "roles": roles, "bands": bands}
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
    print(f"  {len(results)} buckets exported")
    print("=== Done ===")


def main():
    parser = argparse.ArgumentParser(description="Signal Engine Recompute Worker")
    parser.add_argument("--full", action="store_true", help="Full recompute of all candidates")
    parser.add_argument("--incremental", type=int, metavar="NOCODB_ID", help="Incremental recompute for one candidate")
    parser.add_argument("--watch", action="store_true", help="Watch mode: poll for changes")
    parser.add_argument("--db", type=str, help="Path to interview.db (overrides SIGNAL_DB_PATH env)")
    parser.add_argument("--export-json", type=str, metavar="PATH", help="Export benchmark stats as JSON for static site")

    args = parser.parse_args()

    global DB_PATH
    if args.db:
        DB_PATH = args.db

    if args.export_json:
        export_benchmark_json(args.export_json)
    elif args.watch:
        watch_mode()
    elif args.incremental:
        incremental_recompute(args.incremental)
    else:
        full_recompute()


if __name__ == "__main__":
    main()
