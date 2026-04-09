# DEN Fitness ERP

Production-style frontend for DEN Fitness using Supabase as the live database.

## What this version does

- Supabase Auth based login
- Role-based dashboards for `owner`, `trainer`, and `member`
- Live data loading from Supabase tables
- Realtime refresh when attendance, members, or payments change
- Owner can update member plan, fee, trainer assignment, and today's attendance
- Trainer can view all members and create attendance/payment entries only
- Member can view own records and mark attendance via location check-in
- Row Level Security policies included in SQL

## Project files

- `index.html` - app shell
- `styles.css` - UI styling
- `app.js` - live frontend logic using Supabase client
- `js/config.js` - your Supabase project config
- `sql/schema.sql` - tables, trigger, and RLS policies

## Setup

1. Create a Supabase project.
2. Open Supabase SQL Editor.
3. Run `sql/schema.sql`.
4. Open `js/config.js` and replace:
   - `YOUR_PROJECT_ID`
   - `YOUR_SUPABASE_ANON_KEY`
5. In Supabase Authentication, create users for owner, trainer, and members.
6. For the first owner account, update that profile role manually in Supabase SQL:

```sql
update public.profiles
set role = 'owner', full_name = 'DEN Fitness Owner'
where email = 'your-owner-email@example.com';
```

## SQL Server note

- If you need Microsoft SQL Server syntax, use `sql/schema.sqlserver.sql`.
- That file recreates the table structure and trigger behavior in T-SQL.
- Supabase Auth, Row Level Security policies, and realtime subscriptions are Postgres/Supabase-specific and are not available in SQL Server through this project as-is.

7. For trainers, update role manually:

```sql
update public.profiles
set role = 'trainer', full_name = 'Trainer Name'
where email = 'trainer-email@example.com';
```

## Member onboarding flow

- Any new Auth user gets:
  - one `profiles` row
  - one `members` row
  - default role `member`
- Owner can then update that member's plan name, monthly fee, and assigned trainer from the dashboard.

## Important implementation notes

- Trainer cannot update existing member master data because RLS blocks it.
- Member can only see their own member, payment, and attendance rows.
- Member location attendance uses browser geolocation and gym radius from `js/config.js`.
- For best results, open this app through a local web server instead of double-clicking the HTML file.

## Local run

Example:

```bash
python -m http.server 5500
```

Then open `http://localhost:5500`.

## Recommended next backend steps

- Add owner invite flow using Supabase Edge Functions
- Add fee reminder scheduler
- Add reports export (daily, monthly, trainer-wise)
- Add workout plan / diet plan module
- Add expense tracking and salary management
