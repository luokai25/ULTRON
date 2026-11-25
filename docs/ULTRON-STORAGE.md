# Dropbox as Ultron's storage, and the player in chat

Ultron keeps files in the owner's Dropbox through the Composio connection that is already set up: no extra sign-in and no keys in the
app. Code: `apps/phone/src/connectors/dropbox-storage.ts`, the cards in `apps/phone/src/chat-extras.ts`, wiring in `main.ts`.

## Where things live

`/Ultron/Music`, `/Videos`, `/Images`, `/Documents`, `/Files`. `homePath(name)` picks the folder from the file type, and
`safeFileName` makes sure a name can never escape the folder.

## What works

| You ask | What happens |
| --- | --- |
| "Play Night Drive from my Dropbox" | The agent searches, gets an expiring link (`DROPBOX_GET_TEMPORARY_LINK`), and the chat shows a player (songs) or a viewer (videos, pictures) with a Download button. The link is never printed. |
| Tap **Download** on a card | The file is fetched and saved to the phone's Downloads folder (the existing one-time permission). |
| "What's in my Ultron folder?" / "find my notes" | List and search through the normal agent. |
| "Save this link to my Dropbox" | Dropbox fetches the public link itself (`saveUrl`), so nothing passes through the phone. |
| Tap **Save to Dropbox** on a generated picture or video | The bytes go up through Composio's workbench (`uploadBytes`), up to about 3.5 MB. Larger files should be saved from a link. |

Only the file's path is stored on the chat message. Dropbox links last about four hours, so a card asks for a fresh one every time it
is shown, and once more if playback fails because the link expired.

## Limits worth knowing

- Playing needs the phone to reach Dropbox's link directly. Formats the Android WebView cannot play (for example `.mkv`) are listed but
  not given a player.
- Anything the model starts that changes Dropbox goes through the normal approval. The Save button is the owner's own approval.
- The upload route and the temporary-link replies were checked against a real Dropbox account; playback inside the Android WebView
  has not been tried on a device yet.
