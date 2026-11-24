# Homebrew cask

`reviewgate.rb` is the cask published in the tap `seunggulee1007/homebrew-tap` (`Casks/reviewgate.rb`):

```sh
brew install --cask seunggulee1007/tap/reviewgate
```

After a release, `scripts/update-cask.sh X.Y.Z` sets `version` and `sha256` here (from `build/dist/ReviewGate-X.Y.Z.dmg.sha256`,
else from the release's `.sha256` asset). With `HOMEBREW_TAP_DIR=<checkout of the tap>` it also copies the file there;
committing and pushing the tap stays a manual step. `brew style --cask packaging/homebrew/reviewgate.rb` lints it.

The app updates itself (`auto_updates true`), so `brew upgrade` skips it unless `--greedy`. `brew uninstall --zap` also
removes `~/.reviewgate` (the reviews, chats and workbench folders the app keeps) and the app's preferences and caches.
