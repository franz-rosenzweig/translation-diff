# Translation Diff ✨📜

A tiny React + Vite web app that helps translators **compare and refine machine generated translations**.
It shows a _track-changes style_ diff between the original automated translation (e.g. from GPT) and your manual edits, with full support for **bidirectional Hebrew ↔ English text**.

![screenshot](public/vite.svg)

---

## Features

• Word-level diff highlighting (insertions = green, deletions = red, equal = normal) using a Longest Common Subsequence algorithm.

• Bi-directional (LTR & RTL) UI — Hebrew words render correctly inside English sentences and vice-versa.

• In-place WYSIWYG editor that keeps IME composition, undo / redo and copy-paste working.

• One-click translation through the **OpenAI Chat Completions API** (GPT-4o-mini by default) with configurable system prompt, target language, temperature and max tokens.

• Local Storage persistence for API key, preferences and a timestamped translation history.

• Self-tests covering tokenisation & diff edge-cases (`npm run selftest`).

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start Vite dev server (http://localhost:5173)
npm run dev
```

> 💡 The first time you load the page you will be prompted for an **OpenAI API key**
> (stored only in `localStorage.tds_api_key`). You can generate one at <https://platform.openai.com/>.

### Scripts

| Script            | Description                         |
|-------------------|-------------------------------------|
| `npm run dev`     | Vite dev server with HMR            |
| `npm run build`   | Production build to `dist/`         |
| `npm run preview` | Preview the production build        |
| `npm run lint`    | ESLint (config in `eslint.config.js`)|

---

## Project Structure

```
src/
  App.jsx          # main component with diff & editor logic
  assets/          # static assets (SVG logos …)
  index.css        # Tailwind CSS directives
  main.jsx         # React DOM entry-point
public/
  ...              # static files copied verbatim
```

The diff logic lives in `src/App.jsx` and is completely framework-agnostic — you can copy-paste the helper functions into any project.

---

## Releasing

This repository follows **semantic versioning**. A release is created via the GitHub CLI:

```bash
# Commit any pending changes
git add -A && git commit -m "feat: amazing new thing"

# Tag & create release notes (replace x.y.z)
GH_VERSION="v$(npm version --json | jq -r '.version')"   # or set manually

gh release create "$GH_VERSION" \
  --generate-notes \
  --title "$GH_VERSION" \
  --verify-tag
```

The built static site can be deployed to GitHub Pages or any static hosting provider.

---

## Docker

Build and run locally:

```bash
docker build -t translation-diff .
docker run -d --name translation-diff -p 5173:80 --restart=always translation-diff
open http://localhost:5173
```

Update after changes (rebuild):
```bash
docker build -t translation-diff .
docker container rm -f translation-diff
docker run -d --name translation-diff -p 5173:80 --restart=always translation-diff
```

Remove:
```bash
docker rm -f translation-diff
```

---

## License

MIT © 2025 Your Name
