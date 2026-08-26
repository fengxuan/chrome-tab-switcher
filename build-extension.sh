#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${1:-$SCRIPT_DIR/dist}"
if [[ "$OUTPUT_DIR" != /* ]]; then
  OUTPUT_DIR="$PWD/$OUTPUT_DIR"
fi
PACKAGE_PATH="$OUTPUT_DIR/chrome-tab-switcher.zip"
STAGING_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/chrome-tab-switcher-build.XXXXXX")"
STAGING_DIR="$STAGING_ROOT/extension"

cleanup() {
  rm -rf "$STAGING_ROOT"
}
trap cleanup EXIT

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 node，无法检查扩展代码。" >&2
  exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
  echo "错误：未找到 zip，无法生成发布包。" >&2
  exit 1
fi

cd "$SCRIPT_DIR"

node --check background.js
node --check switcher.js
node -e 'JSON.parse(require("fs").readFileSync("manifest.json", "utf8"))'

required_files=(
  manifest.json
  background.js
  switcher.html
  switcher.css
  switcher.js
)

for file in "${required_files[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "错误：缺少扩展文件：$file" >&2
    exit 1
  fi
done

if [[ ! -d "_locales" ]]; then
  echo "错误：缺少扩展国际化资源目录：_locales" >&2
  exit 1
fi

mkdir -p "$STAGING_DIR/vendor" "$STAGING_DIR/_locales" "$OUTPUT_DIR"
cp "${required_files[@]}" "$STAGING_DIR/"
cp -R vendor/. "$STAGING_DIR/vendor/"
cp -R _locales/. "$STAGING_DIR/_locales/"

rm -f "$PACKAGE_PATH"
(cd "$STAGING_DIR" && zip -q -r "$PACKAGE_PATH" . -x '*.DS_Store')

echo "已生成 Chrome 扩展发布包：$PACKAGE_PATH"
