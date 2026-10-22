#!/usr/bin/env bash
# 交叉编译各平台的单文件可执行程序到 dist/
set -euo pipefail

VERSION="${1:-1.17.0}"
OUT="dist"
LDFLAGS="-s -w -X main.version=${VERSION}"

# Windows 图标与版本信息：生成 rsrc_windows_{amd64,arm64}.syso，go build 会自动链接。
# 没装 go-winres 时沿用仓库里已有的 syso 文件。
WINRES="$(go env GOPATH)/bin/go-winres"
[ -x "${WINRES}.exe" ] && WINRES="${WINRES}.exe"
if [ -x "$WINRES" ]; then
  "$WINRES" simply --arch amd64,arm64 \
    --icon assets/ldmapi.ico \
    --product-name "懒大猫 API" \
    --file-description "懒大猫 API - 模型聚合网关" \
    --product-version "$VERSION" \
    --file-version "$VERSION" \
    --original-filename ldmapi.exe
else
  echo "提示：未安装 go-winres，使用仓库内已有的 Windows 资源文件"
  echo "      安装命令：go install github.com/tc-hib/go-winres@latest"
fi

mkdir -p "$OUT"

build() {
  local goos="$1" goarch="$2" name="$3"
  printf '  %-22s' "${goos}/${goarch}"
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -ldflags "$LDFLAGS" -o "$OUT/$name" .
  printf '✓  %s\n' "$(du -h "$OUT/$name" | cut -f1)"
}

echo "构建 懒大猫 API v${VERSION}"
echo

build windows amd64 "ldmapi-windows-amd64.exe"
build windows arm64 "ldmapi-windows-arm64.exe"
build linux   amd64 "ldmapi-linux-amd64"
build linux   arm64 "ldmapi-linux-arm64"
build darwin  amd64 "ldmapi-darwin-amd64"
build darwin  arm64 "ldmapi-darwin-arm64"

echo
echo "完成，产物在 $OUT/"
