# Record a SageMaker endpoint's answers

`rovara record sagemaker` captures your real SageMaker endpoint's answers to a file of synthetic requests, so Rovara's SageMaker fake can serve them in a test run. It runs on your own computer or in your own CI, with your own AWS credentials. It needs no Rovara sign-in, and it sends nothing to Rovara.

## What it does

1. Reads your input file and scans every request for personal data. If it finds any, it stops before it sends anything.
2. Sends each request, one at a time, to your endpoint with the AWS CLI you already have installed (`aws sagemaker-runtime invoke-endpoint`). The AWS CLI signs the call with your credentials. The recorder never reads a credential.
3. Scans every answer, and the headers that come back, for personal data.
4. Writes one file, only if no finding is left open. The file is readable by you only (mode 0600), and an existing file is never replaced unless you pass `--force`.

The recorder prints a kind and a field for each finding (`answers[3].body: an email address`). It never prints a request, an answer or the text it found.

## Run it

```sh
rovara record sagemaker \
  --endpoint fraud-scorer \
  --inputs requests.json \
  --out fraud-scorer.recording.json \
  --region us-east-1
```

`--profile <name>` picks an AWS CLI profile. `--content-type` and `--accept` set the defaults for requests that name none.

### The input file

A JSON array, or JSON Lines, of synthetic requests. A header value may not start with `-`, `file://`, `fileb://`, `http://` or `https://`, because the AWS CLI would read it as an option, a file or an address. Each request has exactly one of `body` (text), `json` (any JSON value) or `bodyBase64` (bytes), and may carry `contentType`, `accept`, `customAttributes`, `targetVariant` and `targetModel`:

```json
[
  { "json": { "amount": 10, "country": "NZ" } },
  { "body": "{\"amount\": 99}", "contentType": "application/json" }
]
```

Use synthetic data only. A request that holds personal data stops the recording, and no redaction applies to requests. Rovara's fake matches a request by its exact bytes, so write the request body exactly as your service sends it. A `json` value is written as compact JSON.

At most 500 requests, 8 MiB in all.

## Personal data

By default a finding in an answer refuses the whole recording and nothing is written. With `--on-finding redact`, each found span is replaced by a fixed placeholder such as `[REDACTED:EMAIL]`, the redacted text is scanned again, and the recording is refused if anything is still found, if the answer is not text, or if the replacement would break the answer's JSON. A finding in a header the endpoint returns always refuses.

Two scanners can run:

- **The built-in scanner** always runs. It has no dependency. It finds email addresses, phone numbers, card numbers (Luhn check), US social security, UK national insurance and Aadhaar-style numbers, IBANs (mod-97 check), IP addresses, the account id in an ARN, people's names (a list of common first names followed by a capitalised word, `Last, First`, and the value of a key such as `first_name` or `customer_name`), and secrets such as provider keys and tokens. It leaves reserved values alone, so synthetic data passes: `example.com`, `.org` and `.net` exactly, one label under `.test`, `.invalid`, `.example` and `.localhost` (`svc.test`, but not `real.gmail.com.invalid`), the 555-01xx phone range, and loopback and documentation addresses.
- **How it reads a text.** It reads each request and answer as written, and as a reader sees it (compatibility forms folded, so full-width digits become digits, and zero-width characters removed). When a body is JSON it also reads it decoded: each string value (so `\u0040` is read as `@`), the document without escapes (so a `customer_name` key is seen beside its value), and all the strings joined (so an address split across two values is seen). Streamed parts are read one by one and joined. Text with a NUL or another control character, and text that is not UTF-8, is treated as binary: it needs `--allow-binary`, and it is read as UTF-8, as UTF-16 of either byte order, and with its NULs removed.
- **What it misses.** It is a heuristic. Look at the file before you upload it. Known gaps:
  - numbers with no separators: a social security number or phone number written as bare digits, a card number written as a JSON number or a float;
  - names it cannot place: a name split across fields, a name under a key that is nested or not on its list of person keys, a lowercase name, and any first name that is not in its list;
  - a value spelled in a way no rule covers (an address written with a different, non-standard `@`, for example);
  - personal data that is not one of the kinds above: dates of birth, street addresses, free-text descriptions of a person, medical or account details.
  A finding that can only be seen in the normalised text, or across two JSON values, cannot be redacted by position; with `--on-finding redact` the recorder then refuses the recording instead.
- **Microsoft Presidio** is optional. Presidio is a Python service, so the recorder does not bundle it. If you run a Presidio analyzer (for example the `presidio-analyzer` container), add `--presidio-url http://localhost:5002`. Findings from both scanners are combined. The analyzer must be on your computer. Another address needs `--allow-remote-presidio`, because your recorded data would be sent to it. If the analyzer cannot be reached, the recording stops.

## Other options

- `--allow-binary` records requests and answers that are not text (including UTF-16 text). They are scanned as described above.
- `--force` replaces an existing output file.

A call that fails for any reason except the model's own error (no credentials, a throttle, an endpoint not found) stops the recording. A model error (`ModelError`) is recorded with its status, because a test may need it.

## Without a recording

An endpoint with no recording and no approved fixture is not run. Rovara names the endpoint and gives the reason in plain words ("no recording of this endpoint's answers; the real model was not run"), and the pull request lists the tests that needed it as not run. Nothing answers in its place, and a test that was not run is never shown as passed. Tests that fake the endpoint themselves run as normal. Recording the endpoint with this command is how a project gets its other tests to run offline.

## After recording

Look through the file, then upload it to Rovara. Rovara scans it again with its own scanner and the synthetic-data guard (so a file that was edited, or recorded by another tool, is still checked), and a person confirms samples before an environment uses it.

The file wraps the fixture document the SageMaker fake accepts (the `fixtures` member), with when and by what it was recorded, and a summary of the scan. Rovara does not trust the summary.
