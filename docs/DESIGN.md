# Design

OpenPrism is a LaTeX editor for one writer. It works on an ordinary folder on disk, compiles on the same machine, and calls AI models through an API with the writer's own keys.

## Stack

| Part | Choice | Why |
|---|---|---|
| Server | Python standard library | No dependencies to install or audit on the server side |
| Page | Plain JavaScript, bundled with esbuild | Small, and easy to read |
| Editor | CodeMirror 6 with the `stex` mode | The standard web code editor, with a LaTeX mode |
| PDF view | `pdfjs-dist` | The standard PDF renderer for the web |
| TeX engine | Tectonic | One binary, MIT licence, fetches packages on demand |
| API keys | The macOS keychain, through the `security` command | The key never sits in a file |
| History | The `git` command | A project stays a normal repository the writer can read |

There is no `synctex` command to rely on, so the app parses `.synctex.gz` itself.

## Screen

- **Project list:** your projects, with search, import and new.
- **Left sidebar:** project menu, files and chats, project search, outline, settings.
- **Middle:** file tabs, a Tools button, the editor, and a chat box floating over the editor.
- **Right:** a white PDF pane with a compile button and jump controls. Tools replaces it with project info, versions, comments and logs.

Errors and warnings appear as marks in the editor margin. Clicking a log line jumps to its source line, and double-clicking the PDF jumps to the source.

## Assistant

- A provider is a type (Anthropic or OpenAI-compatible), a base URL and a key. Pasting a key asks that provider which models the key can use, which costs nothing because no model runs.
- The model and effort are chosen under the message box and sent with each message. A chat can change model at any point. Thinking blocks and tool call ids belong to the model that made them and the two API formats differ, so the new model receives the chat so far as plain text.
- Model names come from the provider when it gives one, and otherwise from the id, so `gpt-6.1-astra` reads as GPT-6.1 Astra. Dated snapshots of a model collapse into one row.
- If a model refuses an effort level, the request steps down until it is accepted and the chat says what ran. The same applies to the output limit and to adaptive thinking.
- The default instructions are `SYSTEM_PROMPT` in `app/assistant.py`. The writer can edit or reset them in Settings, and they apply to every provider.
- The assistant gets the open file, the selection, the file list and the last compile's errors, and it can read other project files.
- It changes the project only by proposing edits. Each one shows as a diff with Keep and Undo, and nothing is written until Keep.
- Before the first request to a provider, the app shows what gets sent and where.
- Requests stream, and Stop ends one.

## Rules the code keeps

- Paths from the page or the model stay inside the project folder. A path that escapes is refused, symlinks included.
- LaTeX runs with shell escape off.
- A key never appears in logs, errors, events or files.
- A saved key goes only to its own provider's address. Changing the type or address in the form empties a pasted key, so a key never follows a changed address.
- The server binds to this machine, checks the Host and Origin headers, and needs the session token. Base URLs must be https, except on this machine.
- The app sends nothing except to the providers the writer set up and, when a compile needs packages, to Tectonic's package server.
- Settings end up in the page's CSS, so the server keeps only known keys with sane values.

## Motion

Animation shows a change of state: a menu opening, a row being chosen, a message arriving, the model thinking. It uses transform, opacity and a little blur, and the Animations setting and the system's reduced-motion setting both turn it down.
