#!/bin/bash

# ═════════════════════════════════════════════════════════════
# GitHub Pages Deploy Script for React Apps
# Usage: bash deploy.sh
# ═════════════════════════════════════════════════════════════

set -e

echo "🚀 Starting GitHub Pages deployment..."

# Check if git is initialized
if [ ! -d ".git" ]; then
    echo "❌ Not a git repository. Please run this in your repo directory."
    exit 1
fi

# Get repo name from git remote
REPO_URL=$(git config --get remote.origin.url)
REPO_NAME=$(basename "$REPO_URL" .git)

echo "📦 Repository: $REPO_NAME"
echo "🔄 Preparing deployment to gh-pages branch..."

# Create/switch to gh-pages branch
if git show-ref --quiet refs/heads/gh-pages; then
    echo "📌 Checking out existing gh-pages branch..."
    git checkout gh-pages
else
    echo "✨ Creating new gh-pages branch..."
    git checkout --orphan gh-pages
    git rm -rf .
fi

# Copy index.html from main branch
echo "📂 Pulling index.html from main branch..."
git checkout main -- index.html

# Alternative: if index.html exists in current directory
if [ ! -f "index.html" ]; then
    echo "❌ index.html not found. Make sure it's in the main branch."
    exit 1
fi

# Create .nojekyll to bypass Jekyll processing
echo "🔧 Creating .nojekyll..."
touch .nojekyll

# Stage, commit, and push
echo "💾 Staging files..."
git add index.html .nojekyll

# Check if there are changes
if git diff --cached --quiet; then
    echo "⏭️  No changes to commit. Skipping push."
else
    echo "📝 Committing..."
    git commit -m "Deploy: $(date '+%Y-%m-%d %H:%M:%S')"
    
    echo "🌐 Pushing to GitHub..."
    git push -u origin gh-pages
fi

# Switch back to main
echo "🔙 Switching back to main branch..."
git checkout main

echo ""
echo "✅ Deployment complete!"
echo "🎉 Your app is live at: https://ayatio.github.io/$REPO_NAME"
echo ""
echo "💡 Tip: The GitHub Pages site updates within a few minutes."
echo "   If you don't see changes, try clearing your browser cache."
