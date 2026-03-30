# AJO Contact History Query Builder

A Data Distiller query generator for Adobe Experience Platform contact history audience building.

**Live Demo:** https://ayatio.github.io/react-ch-query-builder

## What it does

- **Interactive Query Builder**: Configure source (Journey/Campaign), channel, flavor, and filters
- **Live SQL Generation**: See both SELECT and CREATE AUDIENCE queries in real-time
- **Copy to Clipboard**: One-click copy for pasting into Data Distiller
- **Research Tab**: Reference documentation for join keys, feedback statuses, and exclusion codes

## Setup & Deployment

### Prerequisites
- GitHub account
- Git installed locally
- This repository cloned to your machine

### Quick Start

1. **Clone the repository:**
   ```bash
   git clone https://github.com/ayatio/react-ch-query-builder.git
   cd react-ch-query-builder
   ```

2. **Copy the files:**
   - Make sure `index.html` and `deploy.sh` are in the repo root

3. **Make deploy script executable:**
   ```bash
   chmod +x deploy.sh
   ```

4. **Deploy to GitHub Pages:**
   ```bash
   bash deploy.sh
   ```

   The script will:
   - Create/switch to `gh-pages` branch
   - Copy `index.html` from main branch
   - Create `.nojekyll` file
   - Commit and push to GitHub
   - Switch back to main branch

5. **Access your app:**
   ```
   https://ayatio.github.io/react-ch-query-builder
   ```

   ⏱️ Changes appear within a few minutes. Clear cache if needed.

## File Structure

```
react-ch-query-builder/
├── index.html           # Standalone app (all-in-one)
├── deploy.sh            # Deployment script
├── README.md            # This file
└── .github/
    └── workflows/
        └── deploy.yml   # Optional: auto-deploy on push
```

## How to Update

1. **Edit index.html** with new features/fixes
2. **Test locally** by opening `index.html` in a browser
3. **Push to main:**
   ```bash
   git add index.html
   git commit -m "feat: add new feature"
   git push origin main
   ```
4. **Deploy:**
   ```bash
   bash deploy.sh
   ```

## Technical Details

- **Framework**: React 18 (via CDN)
- **Transpiler**: Babel Standalone
- **Build**: None required (runs in browser)
- **Hosting**: GitHub Pages

### How it works

1. `index.html` is a self-contained HTML file
2. React, React-DOM, and Babel are loaded from CDN
3. Component code is written inline in `<script type="text/babel">`
4. Deploy script automates GitHub Pages setup

## Future Enhancements

- [ ] Auto-deploy via GitHub Actions
- [ ] Schema validation for query fields
- [ ] Query template library
- [ ] Dark/light theme toggle

## Support

For issues or questions:
- Check GitHub Issues
- Review the Research tab for field reference

---

**Last Updated:** 2026-03-30
