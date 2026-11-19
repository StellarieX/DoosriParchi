# DoosriParchi

DoosriParchi is a Health Hack prototype for patient-controlled referrals. Patients choose what to share on paper and online, confirm their choices in English or Hindi, and hand the clinic a signed QR. The clinic can verify either QR mode and queue intake offline. Online clinical details and FHIR R4 exports become available after intake is accepted. Patients can see each signed export receipt in their referral timeline.

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

Select **Try a synthetic referral** on the sign-in screen for a guided rehearsal without an account. Progress stays in the current tab. The walkthrough simulates the handoff and uses two real signed sample exports that you can download and verify.

For the two-account demo, use **Send referral** and **Your referrals** as the patient, and **Scan referral** and **Clinic intake** as the clinic.

1. **Patient.** The medical history box is unchecked, yet the preview highlights the same history in the referral note. Select **Use a note without medical history** and check the updated preview.
2. **Confirm.** Select English or Hindi. **Listen to summary** appears when a matching local voice is available. Answer **Yes** first to show the mismatch, then **No** to issue the pass.
3. **Share.** Use the default **Private QR** and save the image. It carries signed referral metadata. The **Minimal offline copy** additionally prints the patient name and the selected lab result. Sign in as North Clinic on the receiving device and wait for **Ready to scan offline**.
4. **Receive.** Scan the QR and select **Accept referral**. Online, the app opens the intake entry with the approved details and opens the appointment form. For the offline demo, disconnect before scanning and check **Clinic intake** for the pending row. Reconnect and confirm the timestamp in **Your referrals**. Scan again to show the clinic still has one intake entry.
5. **Export and withdraw.** In the clinic intake entry, download a FHIR bundle and save its signed receipt. In **Your referrals → Review sharing**, withdraw the online referral note. Download the new export and receipt. The new bundle omits the note, and the patient’s timeline keeps both receipts. The patient can also withdraw other online-only items or revoke the entire referral’s online access.
6. **Request a previous result.** In clinic intake, open **Request previous hemoglobin**, enter the reason, and select **Send request**. The patient can preview the result and choose whether to share it. Once approved, the result can appear in subsequent clinic exports.
7. **Agree on an appointment.** From the clinic intake entry, select **Propose a time**, enter a date and time, and send the offer. The patient can confirm or ask for another time from **Review sharing**. The appointment stays visible after the referral QR expires.
8. **Recover the QR.** Reload the patient workspace and open **Review sharing → Show signed QR**. Download the same pass with its original recipient, printed contents, and expiry. If the pass has expired, **Review a fresh referral** opens a draft from the previous choices for a new consent decision.
9. **Verify and import.** Open **Verify export** and select a FHIR bundle and its matching signed receipt. Try changing a field or pairing the bundle with the other receipt to see verification fail. A verified R4 document can be imported into the simulated clinic queue in that browser tab.

For venue Wi-Fi failure, start the two-account loopback rehearsal before judging. Use separate browser profiles, and keep the rehearsal server running through the demo so its temporary signing key stays available. If you restart it, generate a fresh referral and sample export pair.

An online export receipt identifies the referral, receiving clinic, preparation time, issuer key, and SHA-256 fingerprint of the exact FHIR bytes. It stays verifiable after a withdrawal when the corresponding issuer public key is available. Reformatting the file changes the fingerprint. Both the issuer keys and app shell can be loaded ahead of offline verification.

Anyone with the QR image can decode its printed contents. New offline intake entries retain a signed referral reference and expiry. A clinic can claim a referral until 24 hours after issuance. Expiry and revocation close online clinical access while preserving prior receipts. Earlier downloads and paper copies remain readable. On a shared device, sign out to lock the workspace. If offline, reconnect to finish ending the account session. Reference-only entries can sync when the same clinic account signs in again.

## Connect Supabase and Vercel

1. Apply the SQL files in [the migration directory](supabase/migrations) to the dedicated demo project in filename order. For an existing deployment, apply the outstanding migrations and deploy the matching app build in the same maintenance window. The service API reads and writes these tables after validating the signed-in account and its clinic. The database only accepts one intake row per referral.
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

The Supabase tables hold referral intake metadata and the patient-approved items. The server uses the Supabase secret key after checking ownership or clinic membership. Same-origin HttpOnly cookies hold access and refresh tokens. The service worker caches the app shell, and the browser stores issuer public keys for offline verification. Authenticated referral responses are requested fresh. The SQL integration job replays migrations and checks accepted-clinic access, withdrawal, revocation and receipt retention.

For public patient signup, enable email/password signup and email confirmation in Supabase Auth. Set the Site URL to the production origin and allow the exact confirmation redirect (for example, `https://doosriparchi.vercel.app/?auth=confirmed`). Configure a custom SMTP provider for visitors outside the Supabase organization. Supabase’s built-in mailer is limited to authorized team addresses. Clinic roles are assigned through the SQL step above.

## Deploy the synthetic demo

The Docker image runs as a non-root user. Configure an HTTPS reverse proxy to preserve the public Host header and forward to port 4180. The offline verifier and camera require a secure browser context, with localhost allowed for local development.

Set these values in your host’s secret and environment configuration:

| Setting | Value |
|---|---|
| `PUBLIC_ORIGIN` | The public HTTPS origin, such as `https://referrals.example.org` |
| `REFERRAL_SIGNING_KEY` | Base64-encoded Ed25519 PKCS#8 private key, held in the host’s secret store |
| `REFERRAL_VERIFY_KEYS` | Optional comma-separated Base64-encoded Ed25519 SPKI public keys for prior trusted issuers |
| `PORT` | Listen port, default `4180` |
| `HOST` | Bind address, default `0.0.0.0` in Docker |

Generate the signing key once in a trusted terminal and put its output directly in your secret store. Local development creates a temporary key when no key is configured. Restarting a local server with that temporary key invalidates earlier passes.

```powershell
node -e "const k=require('node:crypto').generateKeyPairSync('ed25519'); console.log(k.privateKey.export({format:'der',type:'pkcs8'}).toString('base64'))"
docker build -t doosriparchi .
docker run --rm -p 127.0.0.1:4180:4180 --env-file .env doosriparchi
```

`GET /healthz` returns the process health using the configured public Host header. Issuance and verification are stateless across instances that share the configured signing key. Provision the receiving browser once online before using it offline.

For routine signing-key rotation, add the outgoing public key from `/api/key` to `REFERRAL_VERIFY_KEYS` and deploy it alongside the new signing key. Use a trusted key history when investigating a compromised key. Newly issued authenticated QRs are stored so the patient can recover the same signed bytes after a routine rotation.

## Scope

All records are synthetic. The preview handles a deliberately seeded disclosure in one referral note. The export is a FHIR R4 document bundle and the receiver is a browser simulation. A production integration would require validation against the receiving organization’s FHIR profiles and workflow, consent rules, clinical requirements, and device security controls.
