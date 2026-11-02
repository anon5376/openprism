# OpenPrism

OpenPrism is a LaTeX editor that runs on your own Mac. It compiles on your machine with Tectonic and uses AI models through your own API keys, from any provider you add. It is open source under the MIT licence.

I started it because OpenAI's Prism shuts down on 1 January 2027. OpenPrism is an independent project, not affiliated with OpenAI or with other projects of the same name, and it is an early build.

## Run it

You need Python 3, Node and Tectonic (`brew install tectonic`).

```bash
cd app/web && npm install --ignore-scripts && npm run build && cd ../..
python3 app/server.py
```

Open the link it prints. The link holds a session token, so keep it to yourself. The server listens only on this machine.

## What it does

- Edits LaTeX beside a live PDF. Clicking an error goes to its line, and double-clicking the PDF goes to the source.
- Imports and exports projects as zip files, and keeps a version history with git inside the project folder.
- Has an assistant that reads your project and proposes edits as diffs. Nothing is written until you press Keep.
- Lists the models from all your providers in one menu, under their normal names. You can switch model at any point in a chat. The new model gets the chat so far as plain text.
- Lets you choose the effort level for each message, and only offers the levels a model reports it can use.
- Lets you edit the instructions sent to the model, and change the theme, colours, fonts, sizes, corners and animations.

## API keys

Open Settings, choose a provider, and paste your key. Anthropic, OpenAI, OpenRouter, Google and xAI are one click, and Other takes any OpenAI-compatible address.

The key goes into the macOS keychain, never into a file, and is sent only to that provider's address. Any program running under your account can ask the `security` tool for that keychain item, so this protects against files and logs, not against other software on your account.

Before the first request to a provider, the app lists what will be sent. The requests and their cost are between you and your provider. Effort starts at Maximum, which is the slowest level and costs the most, so lower it for routine work.

## Limits

- It runs on macOS only, because keys use the macOS keychain, and it has been run on one Mac.
- It is a local server and a browser page, not a packaged desktop app.
- Tectonic runs XeTeX, so projects that need pdfTeX can fail. BibTeX works, and biblatex needs `biber` installed. The first compile downloads packages and can take a few minutes.
- Comments, file uploads in chat, voice, co-editing, a choice of TeX engine and deleting a project from the app are not built.

## Tests

```bash
python3 -m unittest discover -s tests
```

`OPENPRISM_REAL_ENGINE=1` adds a test with real Tectonic. `tests/fake_provider.py` is a stand-in model API for trying the assistant with no key and no cost. To keep a test run away from your real settings, run a second copy with its own `OPENPRISM_HOME`, `OPENPRISM_PROJECTS` and `OPENPRISM_KEYCHAIN_SERVICE`, and its own `--port`.

## How it is built

See [docs/DESIGN.md](docs/DESIGN.md). The licence is in [LICENSE](LICENSE).
