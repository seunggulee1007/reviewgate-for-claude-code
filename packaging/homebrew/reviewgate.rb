cask "reviewgate" do
  version "0.5.25"
  sha256 "b3622d52e603c5e2072b50f5b8bc2ce184f5ed1dab164dc4eb757f53b141fb9c"

  url "https://github.com/seunggulee1007/reviewgate-for-claude-code/releases/download/v#{version}/ReviewGate-#{version}.dmg"
  name "ReviewGate"
  desc "Review every change Claude Code makes before it continues"
  homepage "https://github.com/seunggulee1007/reviewgate-for-claude-code"

  livecheck do
    url :url
    strategy :github_latest
  end

  # The app updates itself from its banner (Install and Restart).
  auto_updates true
  depends_on macos: ">= :sequoia"

  app "ReviewGate.app"

  zap trash: [
    "~/.reviewgate",
    "~/Library/Caches/io.github.seunggulee1007.reviewgate",
    "~/Library/HTTPStorages/io.github.seunggulee1007.reviewgate",
    "~/Library/Preferences/io.github.seunggulee1007.reviewgate.plist",
    "~/Library/Saved Application State/io.github.seunggulee1007.reviewgate.savedState",
  ]
end
