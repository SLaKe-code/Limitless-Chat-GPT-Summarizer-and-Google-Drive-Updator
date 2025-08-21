# Limitless-Chat-GPT-Summarizer-and-Google-Drive-Updator

# Setup Guide for Pendant Summaries

This folder contains all the assets needed to summarise your Limitless Pendant recordings with ChatGPT Pro and store the results in Google Drive. The components are:

* **`limitless.yml`** – OpenAPI schema used by your Custom GPT action. It defines the pendant API endpoints and embeds detailed system instructions telling ChatGPT how to fetch and summarise recordings using hourly windows and strict pagination.
* **`syncPendantToDrive.gs`** – A Google Apps Script that automatically fetches your pendant lifelogs, summarises them, and writes a daily Google Doc into the Drive folder you specify. It includes a resume‑able backfill function.
* **`Smoke_Tests_Pendant.txt`** – Suggested prompts to verify your Custom GPT is working as expected.

## 1. Create your Custom GPT action

1. In ChatGPT Pro open **Explore GPTs → Create**.
2. Name it something like **Pendant Analyst**.
3. Under **Actions**, click **Add Action → Import from file** and upload the provided `limitless.yml`. This file defines two endpoints (`listLifelogs` and `getLifelog`) and includes system instructions about hourly batching, pagination, error handling and the output format. You can verify the instructions by viewing the `description` field inside the YAML.
4. After import, configure authentication: set **API key (custom)**, with header name `X‑API‑Key` and paste your Limitless Pendant API key.
5. Save your GPT. It’s now ready to query your pendant lifelogs.

## 2. Deploy the Google Apps Script

1. Go to https://script.google.com and create a new project named **Pendant Daily Summary**.
2. Replace the default code with the contents of `syncPendantToDrive.gs`.
3. Open **Project Settings → Script properties**, and add:
   * `LIMITLESS_API_KEY` – your pendant API key
   * `FOLDER_ID` – the ID of a Google Drive folder where summaries will be stored (create one called `Pendant_Summaries` and copy its URL ID)
   * `TIMEZONE` – e.g. `America/New_York`
   * `RUN_TODAY` – `false` (to summarise yesterday; set to `true` only for ad‑hoc runs)
4. Authorise and run the function `syncPendantToDrive` once. It should create a document titled `YYYY‑MM‑DD Pendant Summary` in your target folder, even if no lifelogs are found.
5. Use the trigger menu to add a daily time‑driven trigger (e.g. at 06:30). The script will then run automatically every morning.
6. (Optional) To backfill historical summaries, set script properties `BACKFILL_START` and `BACKFILL_END` with ISO dates and run `backfillPendantHistoryResume`. The script will create summaries for each day, skipping those already present unless you set `OVERWRITE=true`.

### Script properties quick reference

| Property        | Purpose                                        |
|-----------------|------------------------------------------------|
| `LIMITLESS_API_KEY` | Your pendant API key                     |
| `FOLDER_ID`         | Target Drive folder ID                    |
| `TIMEZONE`          | Time zone for summary timestamps          |
| `RUN_TODAY`         | `true` to summarise today; `false` (default) summarises yesterday |
| `FORCE_DATE`        | Temporary override date for one‑off runs   |
| `BACKFILL_START`    | Start date for backfill (inclusive)        |
| `BACKFILL_END`      | End date for backfill (inclusive)          |
| `OVERWRITE`         | `true` to regenerate existing summaries during backfill |
| `BACKFILL_STATE`    | Internal pointer for resume‑able backfills |

## 3. Use and verify

After the GPT and script are configured:

1. Ask your Custom GPT questions like:
   * “Summarise yesterday.” – It will fetch 24 hourly windows for the previous day, summarise each lifelog separately, and combine them into a digest.
   * “Summarise 2025‑08‑08.” – Summarise a specific date.
   * “Find the conversation mentioning ‘FSIS’ in the last 14 days and summarise only that meeting.” – Perform a keyword search across multiple days using the pendant API.
2. Check Google Drive to ensure daily documents are being created as scheduled.
3. If you want to regenerate or backfill, use the provided helper functions in the script and adjust script properties accordingly.

### Limitations

* **GitHub repository creation** – The GitHub connector available in this environment is read‑only and does not support creating repositories or uploading files, so we cannot automatically create a GitHub repo or commit these files. You should manually push the `zip` bundle to your own repository.
* **Pendant API scope** – The API only covers pendant recordings (not desktop or web meetings) and returns up to 10 lifelogs per call; the script paginates and slices into hourly windows accordingly.

## 4. Packaging these files

The included zip file bundles all deliverables: `limitless.yml`, `syncPendantToDrive.gs`, this `README_Pendant_ChatGPT_Drive.txt` and the `Smoke_Tests_Pendant.txt`. You can upload this zip to your own GitHub repository manually. See the smoke tests for prompts to validate your setup.
