# Development signing key

`starfield-dev.p12` (alias `starfield`, password `starfield-dev`) signs release APKs when no
private key is configured, so every build from this repository installs and updates cleanly.
It is public: anyone could sign an APK with it. Only install APKs from this repository's
GitHub releases, or configure your own key (see the README, "Signing").
