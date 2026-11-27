cask "reviewgate" do
  version "0.5.37"
  sha256 "8c174b9ce24bff307f2ee0f724c85e22cdd4821f539e3150b164c4dc27520e15"

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
