# DoosriParchi

DoosriParchi is a Health Hack prototype for patient-controlled referrals. Patients choose what to share on paper and online, confirm their choices in English or Hindi, and hand the clinic a signed QR. The clinic can verify the QR offline. With a minimal offline copy, it can also queue intake and sync the acceptance when it reconnects. Online FHIR R4 exports come with a signed receipt the patient can see in their referral timeline.

[Live demo](https://doosriparchi.vercel.app) · [Release history](https://github.com/StellarieX/DoosriParchi/releases)

## Run locally

Use Node.js 24. In PowerShell, from this folder:

```powershell
npm ci
npm start
```

Open [DoosriParchi](http://127.0.0.1:4180). The local workspace runs without accounts when no Supabase settings are present. For the authenticated flow, set the Supabase values in `.env` and start with `node --env-file=.env server.mjs`. For localhost set `NODE_ENV=development`, `HOST=127.0.0.1`, and leave `PUBLIC_ORIGIN` empty. Run `npm test` to check the API, signatures, and sync integration with a local Supabase test fixture.

## Two-account rehearsal

Run `node scripts/rehearse.mjs` for a loopback rehearsal with synthetic accounts and in-memory storage. Open [the rehearsal](http://127.0.0.1:4181) in two browser profiles. Sign in as `patient@example.test` in one and `north@example.test` in the other, using the rehearsal password printed in the terminal. Restarting the rehearsal clears its referrals. The hosted deployment uses Supabase Auth and Postgres.

## Demo

The patient switches between **Send referral** and **Your referrals**. The clinic switches between **Scan referral** and **Clinic intake**. Opening a referral shows its details in a focused view with a back button to the list.

1. **Patient.** The medical history box is unchecked, yet the preview highlights the same history in the referral note. Select **Use a note without medical history** and check the updated preview.
2. **Confirm.** Select English or Hindi. Use **Listen to summary** on a device with a local voice for that language. Answer **Yes** first to show the mismatch, then **No** to issue the pass.
3. **Share.** Preview **Private QR**, the default for signed-in patients. It carries a signed referral reference. The receiving clinic signs in online and selects **Load patient-approved details** to open the record. To demonstrate offline intake, choose **Minimal offline copy** during preview, issue the pass, and save or print the QR. Sign in as North Clinic on the receiving device and wait for the offline readiness message.
4. **Receive.** Turn off networking on the clinic device. Under **Scan referral**, scan the printed code or open the saved QR image and select **Accept referral**. **Clinic intake** shows the pending acceptance. Reconnect and confirm the timestamp appears in **Your referrals**. Scanning the same QR again creates one intake entry in total. **Accepted for intake** means the clinic received the referral and can offer an appointment.
5. **Export and withdraw.** After reconnecting, select **Open intake** and download the FHIR bundle and its signed receipt. In **Your referrals → Review sharing**, withdraw the online referral note. Download a second export and receipt from the same clinic intake entry. The second bundle omits the note, and the patient’s timeline keeps both receipts.
6. **Request a previous result.** In clinic intake, open **Request previous hemoglobin**, enter the reason, and select **Send request**. The patient can preview the result and choose whether to share it. Once approved, the result can appear in subsequent clinic exports.
7. **Agree on an appointment.** From the clinic intake entry, select **Propose a time**, enter a date and time, and send the offer. The patient can confirm or ask for another time from **Review sharing**. The appointment stays visible after the referral QR expires.
8. **Recover the QR.** Reload the patient workspace and open **Review sharing → Show signed QR**. Download the same pass with its original recipient, printed contents, and expiry. If the pass has expired, **Review a fresh referral** opens a draft from the previous choices for a new consent decision.
9. **Verify an export.** Open **Verify export** and select a FHIR bundle and its matching signed receipt. Then try changing a field or pairing the bundle with the other receipt. The verifier checks the exact bytes and the issuer’s signature in the browser. It can verify offline once the browser has loaded the issuer’s public key.

An online export receipt identifies the referral, receiving clinic, and preparation time and contains a SHA-256 fingerprint of the FHIR file. Verification uses this deployment’s issuer key. Reformatting or editing the file changes its fingerprint. Each receipt verifies one export and can be checked after consent changes. Offline downloads contain the QR’s printed information and have the QR signature as their source evidence.

Anyone with a QR image can decode its contents. A private QR carries the referral reference, issuer, destination clinic, and expiry metadata. The patient identity and clinical items are available through authenticated access. The minimal offline copy includes the synthetic patient name and the lab result if selected. Older full-detail passes and the standalone local demo include all selected items on the QR. The signature authenticates the payload and detects edits. The app accepts new intake for up to 24 hours after issuance. Sync pending acceptances before expiry.

## Connect Supabase and Vercel

1. Apply the SQL files in [the migration directory](supabase/migrations) to the dedicated demo project in filename order. On an existing deployment, apply only outstanding migrations. The service API reads and writes these tables after validating the signed-in account and its clinic. The database only accepts one intake row per referral.
2. In Supabase Auth, create confirmed email/password accounts for a demo patient and a clinic. Use demo credentials stored outside Git. Add their Auth user IDs to the role table with the SQL editor:

   ```sql
   insert into public.referral_accounts (user_id, clinic)
   values
     ('<patient-auth-uuid>', null),
     ('<north-clinic-auth-uuid>', 'north');
   ```

   Optionally add a separate South Clinic account with `clinic = 'south'` for the wrong-recipient demonstration. Public signup creates patient workspaces only. The server provisions a patient workspace on the first verified email/password sign-in.
3. Connect the repository to a Vercel project with this directory as its root. Use the included `vercel.json` and set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` and `REFERRAL_SIGNING_KEY` in the intended deployment environment. For an additional custom origin, set `PUBLIC_ORIGIN`. Keep the secret and signing keys server-side. The application accepts the Vercel deployment URLs exposed through Vercel system environment variables.
4. Open the deployed HTTPS URL on both devices and sign into separate accounts. The clinic needs to load the app and issuer key online once per device. If a clinic session expires, sign back into the same account to sync pending work. The patient and clinic views refresh status while visible and online.

The Supabase tables hold referral intake metadata and the patient-approved items. The server uses the Supabase secret key after checking ownership or clinic membership. The browser receives a same-origin, HttpOnly access cookie. The app shell and issuer key are available offline, while authenticated responses are requested fresh.

For public patient signup, enable email/password signup and email confirmation in Supabase Auth. Set the Site URL to the production origin and allow the exact confirmation redirect (for example, `https://doosriparchi.vercel.app/?auth=confirmed`). Configure a custom SMTP provider for visitors outside the Supabase organization. Supabase’s built-in mailer is limited to authorized team addresses. Clinic roles are assigned through the SQL step above.

## Deploy the synthetic demo

The Docker image runs as a non-root user. Configure an HTTPS reverse proxy to preserve the public Host header and forward to port 4180. The offline verifier and camera require a secure browser context, with localhost allowed for local development.

Set these values in your host’s secret and environment configuration:

| Setting | Value |
|---|---|
| `PUBLIC_ORIGIN` | The public HTTPS origin, such as `https://referrals.example.org` |
| `REFERRAL_SIGNING_KEY` | Base64-encoded Ed25519 PKCS#8 private key, held in the host’s secret store |
| `PORT` | Listen port, default `4180` |
| `HOST` | Bind address, default `0.0.0.0` in Docker |

Generate the signing key once in a trusted terminal and put its output directly in your secret store. Local development creates a temporary key when no key is configured. Restarting a local server with that temporary key invalidates earlier passes.

```powershell
node -e "const k=require('node:crypto').generateKeyPairSync('ed25519'); console.log(k.privateKey.export({format:'der',type:'pkcs8'}).toString('base64'))"
docker build -t doosriparchi .
docker run --rm -p 127.0.0.1:4180:4180 --env-file .env doosriparchi
```

`GET /healthz` returns the process health using the configured public Host header. Issuance and verification are stateless across instances that share the configured signing key. Provision the receiving browser once online before using it offline.

## Scope

All records are synthetic and fixed. The preview handles a deliberately seeded disclosure in one referral note. The FHIR export is a collection for inspection or downstream integration. A real clinical deployment requires managed clinic devices, clinic-bound encryption, access and consent auditing, clinical validation of the referral and removal rules, and healthcare security review.
