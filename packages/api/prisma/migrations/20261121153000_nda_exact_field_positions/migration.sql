-- Update the NDA document type with exact, verified vector-aligned review field positions
-- and expanded whiteout boxes that cleanly erase template underscores/placeholders.
UPDATE "document_types"
SET "review_fields_config" = '[
  {
    "key": "start_date",
    "label": "Start Date",
    "placeholder": "e.g. 20th day of November",
    "positions": [
      {
        "pageNumber": 1,
        "xPct": 0.0890,
        "yPct": 0.2006,
        "wPct": 0.7526,
        "hPct": 0.0214,
        "template": "made on this {{start_date}}, 2026 (“Effective Date”), by and between:"
      }
    ]
  },
  {
    "key": "counterparty_legal_name",
    "label": "Counterparty Legal Name",
    "placeholder": "e.g. Acme Solar Pvt Ltd",
    "positions": [
      {
        "pageNumber": 1,
        "xPct": 0.0873,
        "yPct": 0.3075,
        "wPct": 0.8282,
        "hPct": 0.0214,
        "template": "{{counterparty_legal_name}}, a company / LLP / proprietorship incorporated under the laws of"
      },
      {
        "pageNumber": 2,
        "xPct": 0.5107,
        "yPct": 0.7277,
        "wPct": 0.3948,
        "hPct": 0.0214,
        "template": "For {{counterparty_legal_name}}"
      }
    ]
  },
  {
    "key": "company_details",
    "label": "Jurisdiction & Registered Address",
    "placeholder": "e.g. Singapore, with its registered office at 10 Raffles Place #10-01, Singapore 048616",
    "positions": [
      {
        "pageNumber": 1,
        "xPct": 0.0873,
        "yPct": 0.3261,
        "wPct": 0.8282,
        "hPct": 0.0451,
        "template": "{{company_details}} (“Party B”)."
      }
    ]
  },
  {
    "key": "signatory_name",
    "label": "Signatory Name",
    "placeholder": "e.g. Jane Doe",
    "positions": [
      {
        "pageNumber": 2,
        "xPct": 0.5745,
        "yPct": 0.7550,
        "wPct": 0.3276,
        "hPct": 0.0214
      }
    ]
  },
  {
    "key": "signatory_designation",
    "label": "Signatory Designation",
    "placeholder": "e.g. Director",
    "positions": [
      {
        "pageNumber": 2,
        "xPct": 0.6199,
        "yPct": 0.7787,
        "wPct": 0.2856,
        "hPct": 0.0214
      }
    ]
  }
]'::jsonb
WHERE "key" = 'nda';
