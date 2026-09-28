#!/usr/bin/env bash
# DSH 本地插件：一键同步 + 健康检查
#
# 权威源码在本脚本所在工作区；DSH 运行副本在 ~/.dsh/profiles 下。
# 默认执行：同步 canvas-workbench 到全局、desktop、web 与活动 Profile，
# 然后检查源码语法、安装副本、profile 注入项和 DSH HTTP 状态。
#
# 用法：
#   ./sync-local-plugins.sh                  # 同步 + 检查
#   ./sync-local-plugins.sh --check          # 只检查，不复制文件
#   ./sync-local-plugins.sh --install-agent  # 安装登录时/每 5 分钟自动自愈
#   ./sync-local-plugins.sh --remove-agent   # 移除自动任务
#
# DSH 更新器没有稳定、公开的“更新完成”钩子，因此不依赖私有 Electron 事件。
# --install-agent 使用 macOS LaunchAgent 在登录时和固定间隔检查，若更新重建了
# profiles 副本，会在下一次检查时恢复；脚本默认不会擅自安装后台任务。

set -euo pipefail
umask 022

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
USER_HOME="${HOME:?无法确定用户主目录}"
DSH_ROOT="${DSH_ROOT:-$USER_HOME/.dsh}"
PROFILES_ROOT="$DSH_ROOT/profiles"
LOG_DIR="$DSH_ROOT/logs"
LOG_FILE="$LOG_DIR/dsh-local-plugins-sync.log"
AGENT_LABEL="ai.deepseek.dsh.canvas-suite.sync"
LEGACY_AGENT_LABEL="com.ganzhenglin.dsh-local-plugins-sync"
AGENT_PLIST="$USER_HOME/Library/LaunchAgents/$AGENT_LABEL.plist"

MODE="sync"
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    --install-agent) MODE="install-agent" ;;
    --remove-agent) MODE="remove-agent" ;;
    --quiet) QUIET=1 ;;
    -h|--help)
      sed -n '1,32p' "$0"
      exit 0
      ;;
    *)
      printf '未知参数：%s\n' "$arg" >&2
      exit 2
      ;;
  esac
done

mkdir -p "$LOG_DIR"

log_line() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG_FILE"
}

say() {
  log_line "$*"
  if [ "$QUIET" -eq 0 ]; then
    printf '%s\n' "$*"
  fi
}

fail() {
  log_line "ERROR: $*"
  printf '❌ %s\n' "$*" >&2
  exit 1
}

ensure_source() {
  local package="$1"
  local source="$SCRIPT_DIR/$package"
  [ -f "$source/package.json" ] || fail "源码缺少 package.json：$source"
  [ -f "$source/lib/client.js" ] || fail "源码缺少 lib/client.js：$source"
  [ -f "$source/lib/index.js" ] || fail "源码缺少 lib/index.js：$source"
  if [ "$(basename "$source")" = "canvas-workbench" ]; then
    [ -f "$source/lib/image-engine.js" ] || fail "源码缺少 lib/image-engine.js：$source"
    [ -f "$source/lib/chat-image-router.js" ] || fail "源码缺少 lib/chat-image-router.js：$source"
    [ -f "$source/lib/platform.js" ] || fail "源码缺少 lib/platform.js：$source"
  fi
}

sync_package() {
  local package="$1"
  local source="$SCRIPT_DIR/$package"
  local destination selection active

  # Desktop 2.x 可以把任意命名的 Profile 设为活动 Profile。补丁层会把
  # canvas-workbench 注入到 web、desktop 以及活动 Profile；运行副本必须
  # 覆盖同一组目录，否则 loader 会在 Profile 选择阶段停在恢复页。
  selection="$USER_HOME/Library/Application Support/DSH Desktop/profile-selection/state.json"
  active=""
  if [ -f "$selection" ]; then
    active="$(/usr/bin/plutil -extract active raw -o - "$selection" 2>/dev/null || true)"
  fi
  local destinations=(
    "$PROFILES_ROOT/node_modules/@local/$package"
    "$PROFILES_ROOT/desktop/node_modules/@local/$package"
    "$PROFILES_ROOT/web/node_modules/@local/$package"
  )
  if [ -n "$active" ] \
    && [ "$active" != "desktop" ] \
    && [ "$active" != "web" ]; then
    destinations+=("$PROFILES_ROOT/$active/node_modules/@local/$package")
  fi

  for destination in "${destinations[@]}"; do
    mkdir -p "$destination"
    if [ -L "$destination" ]; then
      local source_real destination_real
      source_real="$(cd "$source" && pwd -P)"
      destination_real="$(cd "$destination" && pwd -P)"
      if [ "$source_real" = "$destination_real" ]; then
        say "已同步 $package → ${destination}（已是源码符号链接）"
        continue
      fi
    fi
    if [ -f "$destination/package.json" ] \
      && [ -f "$destination/lib/client.js" ] \
      && [ -f "$destination/lib/index.js" ] \
      && cmp -s "$source/package.json" "$destination/package.json" \
      && cmp -s "$source/lib/client.js" "$destination/lib/client.js" \
      && cmp -s "$source/lib/index.js" "$destination/lib/index.js" \
      && { [ "$(basename "$source")" != "canvas-workbench" ] || cmp -s "$source/lib/image-engine.js" "$destination/lib/image-engine.js"; } \
      && { [ "$(basename "$source")" != "canvas-workbench" ] || cmp -s "$source/lib/chat-image-router.js" "$destination/lib/chat-image-router.js"; } \
      && { [ "$(basename "$source")" != "canvas-workbench" ] || cmp -s "$source/lib/platform.js" "$destination/lib/platform.js"; } \
      && { [ ! -f "$source/README.md" ] || cmp -s "$source/README.md" "$destination/README.md"; } \
      && { [ ! -d "$source/scripts" ] \
        || { [ -d "$destination/scripts" ] \
          && diff -qr "$source/scripts" "$destination/scripts" >/dev/null; }; } \
      && { [ ! -d "$source/src" ] \
        || { [ -d "$destination/src" ] \
          && diff -qr "$source/src" "$destination/src" >/dev/null; }; } \
      && { [ ! -d "$source/adobe-bridge" ] \
        || { [ -d "$destination/adobe-bridge" ] \
          && diff -qr "$source/adobe-bridge" "$destination/adobe-bridge" >/dev/null; }; } \
      && { [ ! -d "$source/vendor" ] \
        || { [ -d "$destination/vendor" ] \
          && diff -qr "$source/vendor" "$destination/vendor" >/dev/null; }; }; then
      say "已是最新，跳过复制：$destination"
      continue
    fi
    # 先完整复制到同级临时目录，再一次性替换。DSH 更新后若刚好正在启动，
    # 不会读到“只复制了一半”的 client/host 文件而进入恢复模式。
    local parent stage previous
    parent="$(dirname "$destination")"
    stage="$parent/.${package}.stage.$$"
    previous="$parent/.${package}.previous.$$"
    rm -rf "$stage" "$previous"
    mkdir -p "$stage"
    cp -R "$source/." "$stage/"
    if [ -e "$destination" ] || [ -L "$destination" ]; then mv "$destination" "$previous"; fi
    if ! mv "$stage" "$destination"; then
      [ -e "$previous" ] && mv "$previous" "$destination"
      fail "原子同步失败，已恢复旧副本：$destination"
    fi
    rm -rf "$previous"
    say "已同步 $package → $destination"
  done
}

patch_entry() {
  local package_id="$1"
  local package_name="$2"
  cat <<EOF
- insert:
    - id: $package_id
      name: '$package_name'
EOF
}

ensure_patch_entry() {
  local patch="$1"
  local package_id="$2"
  local package_name="$3"
  local temp

  [ -f "$patch" ] || return 0
  # 兼容手工维护的 profile 补丁：name 可能带单引号、双引号或不带引号。
  # 只检查带引号会让每次健康检查都重复插入同一个 loader，最终导致
  # `duplicate loader entry id`，DSH Desktop 也就无法启动 web server。
  if grep -qF "name: '$package_name'" "$patch" \
    || grep -qF "name: \"$package_name\"" "$patch" \
    || grep -qF "name: $package_name" "$patch"; then
    return 0
  fi

  temp="$patch.tmp.$$"
  if grep -qE '^[[:space:]]*\[\][[:space:]]*$' "$patch"; then
    # macOS 自带 awk 不接受包含换行的 -v 字符串。先把多行注入项写入
    # 临时文件，再由 awk 读取，避免同步脚本在首次安装时中断。
    local entry_file
    entry_file="$patch.entry.$$"
    patch_entry "$package_id" "$package_name" > "$entry_file"
    awk -v entry_file="$entry_file" '
      BEGIN {
        entry = ""
        while ((getline line < entry_file) > 0) {
          entry = entry (entry == "" ? "" : ORS) line
        }
        close(entry_file)
      }
      /^[[:space:]]*\[\][[:space:]]*$/ { print entry; next }
      { print }
    ' "$patch" > "$temp"
    rm -f "$entry_file"
  else
    {
      cat "$patch"
      printf '\n%s\n' "$(patch_entry "$package_id" "$package_name")"
    } > "$temp"
  fi
  mv "$temp" "$patch"
  say "已补入 profile：$package_name → $patch"
}

remove_patch_entry() {
  local patch="$1"
  local package_id="$2"
  local package_name="$3"
  local temp
  [ -f "$patch" ] || return 0
  grep -qF "name: '$package_name'" "$patch" || return 0
  temp="$patch.tmp.$$"
  awk -v id="$package_id" -v name="$package_name" '
    BEGIN { n=0 }
    { lines[++n]=$0 }
    END {
      for (i=1; i<=n; i++) {
        if (lines[i] ~ /^[[:space:]]*- insert:[[:space:]]*$/ &&
            i+2<=n && lines[i+1] ~ ("id:[[:space:]]*" id "[[:space:]]*$") &&
            index(lines[i+2], "name: \047" name "\047") > 0) { i+=2; continue }
        print lines[i]
      }
    }
  ' "$patch" > "$temp"
  mv "$temp" "$patch"
  say "已移除旧文件浏览器注入：$patch"
}

remove_legacy_home_explorer() {
  local patch target
  if [ -d "$PROFILES_ROOT" ]; then
    while IFS= read -r patch; do
      remove_patch_entry "$patch" home-explorer '@local/home-explorer'
    done < <(find "$PROFILES_ROOT" -maxdepth 2 -name cordis.patch.yml -type f 2>/dev/null)
  fi
  for target in \
    "$PROFILES_ROOT/node_modules/@local/home-explorer" \
    "$PROFILES_ROOT/desktop/node_modules/@local/home-explorer"; do
    if [ -e "$target" ] || [ -L "$target" ]; then
      rm -rf "$target"
      say "已移除独立文件浏览器运行副本：$target"
    fi
  done
}

sync_profiles() {
  [ -d "$PROFILES_ROOT" ] || fail "DSH profiles 目录不存在：$PROFILES_ROOT"

  # 只改桌面会使用的 Profile，绝不再污染 headless 或其他用途的组合。
  # 新版 Desktop 可使用任意命名活动 Profile，因此同时读取它的选择状态。
  local selection="$USER_HOME/Library/Application Support/DSH Desktop/profile-selection/state.json"
  local active=""
  if [ -f "$selection" ]; then
    active="$(/usr/bin/plutil -extract active raw -o - "$selection" 2>/dev/null || true)"
  fi
  for profile in web desktop "$active"; do
    [ -n "$profile" ] || continue
    ensure_patch_entry "$PROFILES_ROOT/$profile/cordis.patch.yml" \
      canvas-workbench '@local/canvas-workbench'
  done

  # dsh-codex 只有被挂到当前 Web/活动 Profile 后，才会向聊天
  # 模型目录注册 openai-codex。仅复制 node_modules 会让画布能找到
  # OAuth 组件，但聊天模型选择器里仍然不会出现 Codex。
  if [ -f "$SCRIPT_DIR/dsh-codex/package.json" ]; then
    for profile in web "$active"; do
      [ -n "$profile" ] || continue
      ensure_patch_entry "$PROFILES_ROOT/$profile/cordis.patch.yml" \
        llm-openai-codex 'dsh-codex'
    done
  fi

  remove_legacy_home_explorer
}

sync_codex_compat() {
  local source="$SCRIPT_DIR/dsh-codex"
  [ -f "$source/package.json" ] || return 0
  [ -f "$source/lib/index.js" ] || fail "内置 dsh-codex 缺少 lib/index.js"

  local selection="$USER_HOME/Library/Application Support/DSH Desktop/profile-selection/state.json"
  local active=""
  if [ -f "$selection" ]; then
    active="$(/usr/bin/plutil -extract active raw -o - "$selection" 2>/dev/null || true)"
  fi
  local destination parent stage previous
  local destinations=("$PROFILES_ROOT/node_modules/dsh-codex")
  if [ -n "$active" ]; then
    destinations+=("$PROFILES_ROOT/$active/node_modules/dsh-codex")
  fi
  for destination in "${destinations[@]}"; do
    parent="$(dirname "$destination")"
    mkdir -p "$parent"
    if [ -f "$destination/package.json" ] \
      && cmp -s "$source/package.json" "$destination/package.json" \
      && diff -qr "$source/lib" "$destination/lib" >/dev/null 2>&1; then
      say "已是最新，跳过复制：$destination"
      continue
    fi
    stage="$parent/.dsh-codex.stage.$$"
    previous="$parent/.dsh-codex.previous.$$"
    rm -rf "$stage" "$previous"
    mkdir -p "$stage"
    cp -R "$source/." "$stage/"
    if [ -e "$destination" ] || [ -L "$destination" ]; then mv "$destination" "$previous"; fi
    if ! mv "$stage" "$destination"; then
      [ -e "$previous" ] && mv "$previous" "$destination"
      fail "dsh-codex 原子同步失败：$destination"
    fi
    rm -rf "$previous"
    say "已同步 dsh-codex 兼容版 → $destination"
  done
}

check_codex_compat() {
  local source="$SCRIPT_DIR/dsh-codex"
  [ -f "$source/package.json" ] || return 0
  local installed="$PROFILES_ROOT/node_modules/dsh-codex"
  [ -f "$installed/package.json" ] || fail "dsh-codex 兼容版尚未安装"
  cmp -s "$source/package.json" "$installed/package.json" \
    || fail "dsh-codex 版本与套件不一致"
  diff -qr "$source/lib" "$installed/lib" >/dev/null \
    || fail "dsh-codex 运行文件与套件不一致"
  say "兼容组件通过：dsh-codex $(/usr/bin/plutil -extract version raw -o - "$source/package.json" 2>/dev/null || printf '内置版')"
}

check_package() {
  local package="$1"
  local source="$SCRIPT_DIR/$package"
  local destination selection active

  selection="$USER_HOME/Library/Application Support/DSH Desktop/profile-selection/state.json"
  active=""
  if [ -f "$selection" ]; then
    active="$(/usr/bin/plutil -extract active raw -o - "$selection" 2>/dev/null || true)"
  fi
  local destinations=(
    "$PROFILES_ROOT/node_modules/@local/$package"
    "$PROFILES_ROOT/desktop/node_modules/@local/$package"
    "$PROFILES_ROOT/web/node_modules/@local/$package"
  )
  if [ -n "$active" ] \
    && [ "$active" != "desktop" ] \
    && [ "$active" != "web" ]; then
    destinations+=("$PROFILES_ROOT/$active/node_modules/@local/$package")
  fi

  if command -v node >/dev/null 2>&1; then
    node --check "$source/lib/client.js" >/dev/null \
      || fail "$package/lib/client.js 语法检查失败"
    node --check "$source/lib/index.js" >/dev/null \
      || fail "$package/lib/index.js 语法检查失败"
    if [ "$package" = "canvas-workbench" ]; then
      node --check "$source/lib/image-engine.js" >/dev/null \
        || fail "$package/lib/image-engine.js 语法检查失败"
      node --check "$source/lib/chat-image-router.js" >/dev/null \
        || fail "$package/lib/chat-image-router.js 语法检查失败"
    fi
    say "语法通过：$package"
  else
    say "⚠ 未安装 Node.js，跳过开发期语法检查：$package（不影响 DSH 加载已打包插件）"
  fi

  for destination in "${destinations[@]}"; do
    [ -f "$destination/package.json" ] \
      || fail "安装副本缺少 package.json：$destination"
    [ -f "$destination/lib/client.js" ] \
      || fail "安装副本缺少 lib/client.js：$destination"
    [ -f "$destination/lib/index.js" ] \
      || fail "安装副本缺少 lib/index.js：$destination"
    cmp -s "$source/package.json" "$destination/package.json" \
      || fail "package.json 与安装副本不一致：$destination"
    cmp -s "$source/lib/client.js" "$destination/lib/client.js" \
      || fail "lib/client.js 与安装副本不一致：$destination"
    cmp -s "$source/lib/index.js" "$destination/lib/index.js" \
      || fail "lib/index.js 与安装副本不一致：$destination"
    if [ "$package" = "canvas-workbench" ]; then
      [ -f "$destination/lib/image-engine.js" ] \
        || fail "安装副本缺少 lib/image-engine.js：$destination"
      cmp -s "$source/lib/image-engine.js" "$destination/lib/image-engine.js" \
        || fail "lib/image-engine.js 与安装副本不一致：$destination"
      [ -f "$destination/lib/chat-image-router.js" ] \
        || fail "安装副本缺少 lib/chat-image-router.js：$destination"
      cmp -s "$source/lib/chat-image-router.js" "$destination/lib/chat-image-router.js" \
        || fail "lib/chat-image-router.js 与安装副本不一致：$destination"
      [ -f "$destination/lib/platform.js" ] \
        || fail "安装副本缺少 lib/platform.js：$destination"
      cmp -s "$source/lib/platform.js" "$destination/lib/platform.js" \
        || fail "lib/platform.js 与安装副本不一致：$destination"
    fi
    if [ -f "$source/README.md" ]; then
      [ -f "$destination/README.md" ] \
        || fail "安装副本缺少 README.md：$destination"
      cmp -s "$source/README.md" "$destination/README.md" \
        || fail "README.md 与安装副本不一致：$destination"
    fi

    if [ -d "$source/scripts" ]; then
      [ -d "$destination/scripts" ] \
        || fail "安装副本缺少 scripts：$destination"
      diff -qr "$source/scripts" "$destination/scripts" >/dev/null \
        || fail "scripts 与安装副本不一致：$destination"
    fi
    say "副本一致：$destination"
  done
}

check_profiles() {
  local patch selection active
  selection="$USER_HOME/Library/Application Support/DSH Desktop/profile-selection/state.json"
  active=""
  if [ -f "$selection" ]; then
    active="$(/usr/bin/plutil -extract active raw -o - "$selection" 2>/dev/null || true)"
  fi
  if [ -n "$active" ] && [ -f "$PROFILES_ROOT/$active/cordis.patch.yml" ]; then
    patch="$PROFILES_ROOT/$active/cordis.patch.yml"
    grep -qF "name: '@local/canvas-workbench'" "$patch" \
      || fail "当前活动 profile 未注入 canvas-workbench：$patch"
    if [ -f "$SCRIPT_DIR/dsh-codex/package.json" ]; then
      grep -qF "name: 'dsh-codex'" "$patch" \
        || fail "当前活动 profile 未注入 dsh-codex：$patch"
    fi
    say "活动 profile 通过：$active"
  fi

  if grep -RqsF "name: '@local/home-explorer'" "$PROFILES_ROOT"/*/cordis.patch.yml 2>/dev/null; then
    fail "仍有 profile 注入旧 home-explorer"
  fi
}

check_compatibility_contract() {
  # 客户端只能把稳定的 slots 声明为硬依赖；其他 DSH 服务必须能力探测。
  grep -qF "exports.inject = ['slots']" "$SCRIPT_DIR/canvas-workbench/lib/client.js" \
    || fail "canvas-workbench 声明了不稳定的客户端硬依赖"
  grep -qF "ctx.inject(['conversation']" "$SCRIPT_DIR/canvas-workbench/lib/client.js" \
    || fail "canvas-workbench 未通过兼容层延迟获取 conversation 服务"
  grep -qF "api.events.register(canvasImagesDefinition)" "$SCRIPT_DIR/canvas-workbench/lib/client.js" \
    || fail "canvas-workbench 未注册会话图片事件"
  grep -qF "typeof ctx.slots.inject !== 'function'" "$SCRIPT_DIR/canvas-workbench/lib/client.js" \
    || fail "canvas-workbench 未对 slots 做能力探测"
  local version="未知"
  if [ -f "/Applications/DSH Desktop.app/Contents/Info.plist" ]; then
    version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' '/Applications/DSH Desktop.app/Contents/Info.plist' 2>/dev/null || printf '未知')"
  fi
  say "兼容层通过：DSH Desktop ${version}（可选会话能力不会阻断启动）"
}

check_dsh() {
  local code
  if ! command -v curl >/dev/null 2>&1; then
    say "⚠ 未找到 curl，跳过 DSH HTTP 检查"
    return 0
  fi
  code="$(curl -sS -o /dev/null --max-time 3 -w '%{http_code}' \
    http://127.0.0.1:43120/ 2>/dev/null || true)"
  if [[ "$code" =~ ^[23][0-9][0-9]$ ]]; then
    say "DSH HTTP 检查通过：127.0.0.1:43120（HTTP $code）"
  elif [[ "$code" =~ ^4(01|03)$ ]]; then
    # 2.0.4 默认要求桌面会话授权；401/403 说明服务已监听，不能误报为未启动。
    say "DSH HTTP 检查通过：127.0.0.1:43120（HTTP ${code}，服务已监听并要求授权）"
  else
    # DSH 未启动不阻断文件同步；启动 DSH 后再次执行 --check 即可确认。
    say "⚠ DSH HTTP 当前不可用（状态：${code:-连接失败}），文件检查仍已完成"
  fi
}

install_agent() {
  local uid
  uid="$(id -u)"
  mkdir -p "$(dirname "$AGENT_PLIST")"
  # 迁移早期仅适用于开发机的任务名，避免安装公共分发包后重复轮询。
  launchctl bootout "gui/$uid/$LEGACY_AGENT_LABEL" >/dev/null 2>&1 || true
  rm -f "$USER_HOME/Library/LaunchAgents/$LEGACY_AGENT_LABEL.plist"
  cat > "$AGENT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$AGENT_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$SCRIPT_DIR/sync-local-plugins.sh</string>
    <string>--quiet</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_FILE</string>
  <key>StandardErrorPath</key>
  <string>$LOG_FILE</string>
</dict>
</plist>
EOF

  launchctl bootout "gui/$uid/$AGENT_LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$uid" "$AGENT_PLIST" \
    || fail "LaunchAgent 安装失败：$AGENT_PLIST"
  launchctl kickstart -k "gui/$uid/$AGENT_LABEL" >/dev/null 2>&1 || true
  say "已安装自动同步任务：登录时运行，并每 5 分钟检查一次"
  say "日志：$LOG_FILE"
}

remove_agent() {
  local uid
  uid="$(id -u)"
  launchctl bootout "gui/$uid/$AGENT_LABEL" >/dev/null 2>&1 || true
  launchctl bootout "gui/$uid/$LEGACY_AGENT_LABEL" >/dev/null 2>&1 || true
  if [ -f "$AGENT_PLIST" ]; then
    rm -f "$AGENT_PLIST"
    say "已移除自动同步任务：$AGENT_PLIST"
  else
    say "自动同步任务未安装"
  fi
  rm -f "$USER_HOME/Library/LaunchAgents/$LEGACY_AGENT_LABEL.plist"
}

if [ "$MODE" = "remove-agent" ]; then
  remove_agent
  exit 0
fi

ensure_source canvas-workbench

# 全新电脑上，DSH Desktop 可能还没有首次启动，因而 profiles 尚未生成。
# 安装器模式下先装 LaunchAgent，后台任务会在 DSH 创建 profile 后自动完成注入。
if [ ! -d "$PROFILES_ROOT" ] && [ "$MODE" = "install-agent" ]; then
  install_agent
  say "DSH profiles 尚未生成；已进入延迟同步，首次启动 DSH 后会自动完成"
  exit 0
fi

if [ "$MODE" != "check" ]; then
  sync_profiles
  sync_package canvas-workbench
  sync_codex_compat
fi

check_package canvas-workbench
check_codex_compat
check_compatibility_contract
check_profiles
check_dsh

if [ "$MODE" = "install-agent" ]; then
  install_agent
fi

if [ "$MODE" = "check" ]; then
  say "✅ 健康检查完成"
else
  say "✅ 同步与健康检查完成"
fi
