# Candidate Search Scripts

Helper scripts for querying the NocoDB candidate database.

## Usage

```bash
# Source the env vars
source .env.local

# Get candidates (use table ID, not name)
curl -H "xc-token: $NOCODB_TOKEN" \
  "$NOCODB_URL/api/v2/tables/$NOCODB_TABLE_ID/records?limit=10"

# Search by name
curl -H "xc-token: $NOCODB_TOKEN" \
  "$NOCODB_URL/api/v2/tables/$NOCODB_TABLE_ID/records?where=(Full-Name,like,Hadi)"

# Filter by skills
curl -H "xc-token: $NOCODB_TOKEN" \
  "$NOCODB_URL/api/v2/tables/$NOCODB_TABLE_ID/records?where=(Programming%20Language%20(professionally%20used),like,Python)"
```

## Key Fields

| Field | Type | Notes |
|-------|------|-------|
| Id | Number | Primary key |
| Full-Name | Text | Candidate name |
| Email | Email | Contact email |
| Phone Number | Phone | WhatsApp link in `walink` |
| LinkedIn Link | URL | Profile URL |
| Upload CV | URL | Google Drive link |
| Total Years of Experience | Text | Experience level |
| Programming Language | Text | Skills (comma-separated) |
| Cloud Expertise | Text | AWS, GCP, etc. |
| Expected Salary | Text | Nett in IDR |
| Notice Period | Text | Availability |
| Working arrangement preferences | Text | Remote/Hybrid/On-Site |

## API Reference

NocoDB API v2 docs: https://docs.nocodb.com/developer-resources/rest-api/overview/
