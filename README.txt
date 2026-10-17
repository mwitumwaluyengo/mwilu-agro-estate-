MWILU AGRO ESTATE - ONLINE VERSION (Cloudflare Pages + D1 database)
=====================================================================
This folder replaces the browser LocalStorage with a real online database, so
the same data shows on every phone / computer. All your screens, roles, HR,
shop, leave, recruitment etc. are unchanged.

FILES
  index.html    the full Mwilu system (your v15, with storage changed to online)
  _worker.js    the small server program (login, saving, file uploads, security)

SET-UP (about 10 minutes, all in the Cloudflare dashboard, no coding)
---------------------------------------------------------------------
1. Create the database
   Cloudflare dashboard > Storage & Databases > D1 SQL database > Create database
   Name:  mwilu-db     (leave everything else as it is)
   You do NOT create any tables - the system creates them by itself.

2. Create the website
   Workers & Pages > Create > Pages > "Upload assets" (Direct Upload)
   Project name: e.g. mwilu  >  upload the ZIP file  >  Deploy.
   (The site will show an error until steps 3 and 4 are done - that is normal.)

3. Connect the database
   Your Pages project > Settings > Bindings > Add > D1 database
   Variable name:  DB      (capital letters, exactly)
   D1 database:    mwilu-db
   Do this for Production (and Preview if shown).

4. Set the first passwords (IMPORTANT - do this before anyone opens the site)
   Same Settings page > Variables and Secrets > Add (type: Secret):
     ADMIN_PIN    = a strong PIN / password for the 'admin' account
     OWNER_PIN    = a PIN for the 'owner' account
     MANAGER_PIN  = a PIN for the 'manager' account
   If you skip this, the 3 starter accounts get PIN 1234 - change them at once.

5. Deploy again so steps 3 and 4 take effect
   Deployments > "Create new deployment" (or Upload) > upload the SAME ZIP again.
   Open your site address (xxxx.pages.dev). Log in as  admin  with your ADMIN_PIN.

6. Bring over your old data (if you already had data in the old file version)
   Browser data is tied to the old address, so it cannot move by itself:
     a) Open the OLD version > log in as Admin > Backup (download the backup file)
     b) Open the NEW online site > log in as Admin > Restore backup > choose that file
   Backup/Restore includes uploaded PDFs; they go to the online database.

DAILY USE
  - Open the site on any device, log in, work. Changes are saved at once and other
    devices see them within about 10 seconds (no need to refresh).
  - A small pill at the bottom-left shows "Saving..." or "Offline" when relevant.
    If the internet drops, keep the page open: it saves when the connection returns.
  - Staying logged in survives a page refresh; closing the tab logs you out.
    Sessions last 12 hours.

WHO CAN SEE / CHANGE WHAT (enforced by the server, not only by the screen)
  - Visitors: public website only (news, available goats, published vacancies,
    shop items). They can only ADD applications / registrations / orders.
  - Applicants, Employees, Caretakers: only their own records + shared reference data.
  - Staff roles (HR, Accounts, Manager...): everything their role needs; nobody except
    admin sees other people's PINs; only admin/owner can change roles and site settings.
  - Wrong PIN 8 times = locked for 10 minutes.
  To tune this, edit the lists at the top of _worker.js (clearly labelled).

GOOD TO KNOW / LIMITS
  - PINs are stored as plain text inside your private database (same as before).
    Use real passwords for admin/owner and never reuse a personal password.
  - If two people create a record at the SAME second and get the same number
    (e.g. both APP-2026-0007), the second person gets a message to repeat the action.
  - One saved record can be about 1.8 MB (a photo is shrunk automatically by the app).
    Uploaded files (PDF/photos) up to 15 MB each.
  - Free plan is plenty for a farm office: 100,000 requests/day, D1 5 GB.
    Each open, logged-in screen uses about 6 requests a minute. If you ever see
    "Error 1102 / exceeded resources", switch the project to the paid Workers plan.
  - Optional login photo: add a file named login-bg.jpg next to index.html and
    re-deploy (or set it from inside the system as before).
