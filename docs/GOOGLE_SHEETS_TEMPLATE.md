# Google Sheets template

Schema reference only in Milestone 0. No workbook, provider, wizard or live sync is implemented yet. Use fictional data when testing; never place API keys in Sheets. Real private access is deferred.

## Tabs and headers

| Tab              | Required template headers                                                                                                                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Business_Profile | business_id, business_name, industry, timezone, website, support_phone, default_language, supported_languages, tone, greeting, working_hours, active                                                                                               |
| Knowledge        | id, record_type, category, title, aliases, sample_questions, short_answer, detailed_answer, price, availability, requirements, processing_time, process_steps, keywords, language, priority, requires_handoff, active, updated_at                  |
| Reply_Templates  | template_id, intent, language, immediate_reply, success_followup, failure_followup, active                                                                                                                                                         |
| Escalation_Rules | rule_id, business_id, keywords, intent, priority, action, team, delay_minutes, active                                                                                                                                                              |
| Tickets          | created_at, ticket_id, business_id, chat_key, customer_display_name, masked_customer_identifier, question, detected_intent, matched_knowledge_id, priority, status, assigned_team, notified_at, followup_due_at, followup_sent_at, resolution_note |
| Settings         | key, value, description, active                                                                                                                                                                                                                    |

## Normalization contract

Stable record IDs must be unique within a business. Preserve displayed price strings verbatim, including currency and units. Use TRUE/FALSE for booleans, ISO timestamps for updated_at, and en/kn/te/ta/hi for language. record_type: PRODUCT, SERVICE, FAQ, PROCESS, POLICY, OFFER, CONTACT, LOCATION. Knowledge priority: NORMAL or IMPORTANT. Ticket priority: NORMAL, FOLLOW_UP, HIGH.

Providers normalize comma-separated aliases and keywords and configured list columns into arrays. Process steps may be separated by newlines or `|`. Keep dates, URLs, names and exact prices intact. Rows are scoped with an internal profileId supplied by the selected connection, not trusted from remote data.

## Mapping wizard requirements (Milestones 3–4)

Preview ten rows, suggest column matches, allow manual override, validate each row and surface errors without silent drops. Example: Item → title, Rate → price, Details → detailed_answer, Available → availability; Service Name → title, Charge → price, Documents → requirements, Delivery Time → processing_time.

Save mapping JSON separately per profile and validate imports as data. Report counts, row numbers, issues, last sync and last successful sync. Cache the last-known-good dataset if sync fails. Do not replace healthy data silently with invalid rows.

## Planned fictional fixtures

Sweet Crumbs Bakery: Chocolate Truffle Cake, ₹650 for 500 grams, eggless available, minimum six hours advance time. Custom Photo Cake asks for weight, flavour, date, pickup/delivery time and a clear photo.

Sample E-Governance Services: Vehicle RC PDF, driving licence download, voter mobile linking. These are fictional examples, not live service, eligibility, price or government policy claims. No sensitive documents belong in fixtures.
