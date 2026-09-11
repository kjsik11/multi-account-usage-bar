APP_NAME    = MultiAccountUsageBar
# The 1.x app, removed by `make install` / `make uninstall` so two copies never run.
LEGACY_APP  = ClaudeUsageBar
BUNDLE_ID   = io.github.kjsik11.multi-account-usage-bar
VERSION    ?= 1.2.0
BUILD_DIR   = build
APP_BUNDLE  = $(BUILD_DIR)/$(APP_NAME).app
CONTENTS    = $(APP_BUNDLE)/Contents
DMG         = $(BUILD_DIR)/$(APP_NAME).dmg
# Build for the Mac this runs on (arm64 or x86_64); override ARCH to cross-build.
ARCH       ?= $(shell uname -m)
SWIFT_FLAGS = -O -framework AppKit -target $(ARCH)-apple-macosx13.0

.PHONY: all app dmg install uninstall run clean

all: app

$(BUILD_DIR):
	@mkdir -p $(BUILD_DIR)

app: $(BUILD_DIR)
	@rm -rf $(APP_BUNDLE)
	@mkdir -p $(CONTENTS)/MacOS $(CONTENTS)/Resources
	@echo "→ compiling $(APP_NAME)"
	@swiftc $(SWIFT_FLAGS) $(APP_NAME).swift -o $(CONTENTS)/MacOS/$(APP_NAME)
	@echo "→ bundling the CLI so the app needs only Node"
	@cp ../cli.mjs $(CONTENTS)/Resources/cli.mjs
	@mkdir -p $(CONTENTS)/Resources/src
	@cp ../src/core.mjs $(CONTENTS)/Resources/src/core.mjs
	@sed -e 's/__VERSION__/$(VERSION)/g' -e 's/__BUNDLE_ID__/$(BUNDLE_ID)/g' -e 's/__APP_NAME__/$(APP_NAME)/g' Info.plist.in > $(CONTENTS)/Info.plist
	@cp icon.icns $(CONTENTS)/Resources/AppIcon.icns 2>/dev/null || true
	@codesign --force --deep --sign - $(APP_BUNDLE) 2>/dev/null || echo "  (ad-hoc signing unavailable — the app still runs locally)"
	@echo "✔ $(APP_BUNDLE)"

dmg: app
	@rm -f $(DMG)
	@rm -rf $(BUILD_DIR)/dmg && mkdir -p $(BUILD_DIR)/dmg
	@cp -R $(APP_BUNDLE) $(BUILD_DIR)/dmg/
	@ln -s /Applications $(BUILD_DIR)/dmg/Applications
	@hdiutil create -volname "$(APP_NAME)" -srcfolder $(BUILD_DIR)/dmg -ov -format UDZO $(DMG) >/dev/null
	@rm -rf $(BUILD_DIR)/dmg
	@echo "✔ $(DMG)"

install: app
	@pkill -x $(APP_NAME) 2>/dev/null || true
	@pkill -x $(LEGACY_APP) 2>/dev/null || true
	@sleep 1
	@rm -rf /Applications/$(APP_NAME).app /Applications/$(LEGACY_APP).app
	@cp -R $(APP_BUNDLE) /Applications/
	@echo "✔ installed to /Applications/$(APP_NAME).app"
	@open /Applications/$(APP_NAME).app

uninstall:
	@pkill -x $(APP_NAME) 2>/dev/null || true
	@pkill -x $(LEGACY_APP) 2>/dev/null || true
	@rm -rf /Applications/$(APP_NAME).app /Applications/$(LEGACY_APP).app
	@echo "✔ removed"

run: app
	@pkill -x $(APP_NAME) 2>/dev/null || true
	@open $(APP_BUNDLE)

clean:
	@rm -rf $(BUILD_DIR)
