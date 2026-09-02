# Gemini Web Bridge

A Chrome/Brave extension that pairs the page you are working on with a Gemini tab, numbers
every interactive element on that page, and sends Gemini a screenshot it can point at.

You ask *"what do I fill in next?"* and Gemini answers *"type the invoice number in **7**,
then click **12**"* — because both of you are looking at the same numbered picture.

No API key, no quota, no billing. It drives the Gemini web app you are already logged into.

---

## Why this exists

A language model that can see your screen is only half useful if it has no way to refer to
what it sees. *"The blue button under the heading"* is ambiguous on a dense page; a number
painted on that button is not.

So the extension does three things a plain screenshot cannot:

1. **Paints numbered badges** over the interactive elements of the page, so both sides of the
   conversation share one vocabulary.
2. **Keeps two tabs linked** — your work tab and a Gemini tab — grouped together in the
   browser, so the context does not drift when you open something else.
3. **Captures at send time**, not before, so what Gemini receives is the page as it is when
   you ask, not as it was a minute ago.

It is a hand-rolled version of the visual-grounding technique agent systems use to operate a
screen. Useful for filling long forms, navigating unfamiliar admin panels, and getting a
second opinion on a layout.

---

## Install

Not on the Chrome Web Store — it requests broad host permissions by design (see
[Permissions](#permissions)). Load it unpacked:

1. Clone the repo.
2. Open `chrome://extensions` (or `brave://extensions`).
3. Enable **Developer mode**.
4. **Load unpacked** → select the repo folder.
5. Pin the extension, open the page you want to work on, and click the icon.

Manifest V3. No build step, no dependencies.

---

## Using it

**Link the tabs.** Open the extension on your work tab and pick which Gemini tab to pair with.
It will not hijack an existing conversation — you choose. Both tabs are placed in the same
browser tab group so they stay together.

**Choose what to capture.** Three scopes:

| Scope | What it sends |
| :--- | :--- |
| **Visible screen** | Exactly the current viewport |
| **Full page** | Scrolls top to bottom and stitches the sections into one image |
| **Region** | Drag to select a rectangle |

**Number the elements.** Badges are painted over links, buttons, inputs, selects, textareas,
contenteditable regions and anything carrying an interactive ARIA role, before the capture, so
they are *in* the image Gemini receives, and Gemini is told what the numbers mean. They
realign themselves when the layout shifts. `Alt+Shift+N` renumbers them, `Alt+Shift+C` clears them.

**Ask.** The screenshot is injected into the Gemini chat box with a structured prompt and
sent. The answer refers to your page by number.

---

## How full-page capture works

The interesting part. Chrome will only hand an extension the *visible* part of a tab, so a
full-page capture has to be assembled:

- Measure the document height and the device pixel ratio — get the second one wrong and the
  stitched image is subtly doubled or halved on a retina display.
- Hide the scrollbars so they do not appear as seams in the middle of the picture.
- Show a small progress banner, and take care that the banner itself never lands in a shot.
- Scroll one viewport at a time, waiting for repaints and lazy content to settle before each
  capture. Chrome rate-limits `captureVisibleTab`, so the loop is throttled to stay inside
  the quota instead of failing halfway down a long page.
- Stitch the sections. Capture stops at 20,000px of document height, and a montage taller than
  10,000px is scaled down proportionally rather than cropped — you lose resolution, never content.
- **Restore the page exactly as it was** — scroll position and styles included. The user
  should not be able to tell the extension was there.

If any step fails, the error names the step that failed rather than reporting a generic
"capture error".

---

## Permissions

| Permission | Why |
| :--- | :--- |
| `activeTab`, `tabs`, `tabGroups` | Pair the work tab with the Gemini tab and group them |
| `scripting` | Paint the badges and read the layout of the page |
| `storage` | Remember the pairing and your settings |
| `<all_urls>` | The point of the extension is that it works on *any* page you are on |

The extension makes no network requests of its own — there is no server, no telemetry and no
account. The only thing that leaves the page is the screenshot you send, and it goes into the
Gemini tab you picked.

---

## Limitations

- It automates the Gemini **web interface**, not the API. If Google changes that page, this
  breaks until it is updated.
- Badges are placed over elements the page exposes as interactive. Custom widgets that do not
  present themselves as such may be missed.
- Pages taller than 20,000px are captured only down to that point. Between 10,000 and 20,000px the
  stitched image is scaled down to fit.

---

## Development notes

Roughly 2,300 lines of JavaScript, no framework:

```
background/background.js   orchestration: capture, scroll loop, stitching, tab pairing
content/badges.js          numbered overlay, realignment on layout change
content/crop_overlay.js    region selection
content/gemini_bridge.js   injecting the screenshot and prompt into the Gemini chat box
popup/                     scope selection and link status
```

The commit history is the design log — each version is one user-visible change, in order.

## Scope

Personal project, shared as is. Bug reports are welcome; I am not taking feature requests.

## License

MIT. See [LICENSE](LICENSE).
