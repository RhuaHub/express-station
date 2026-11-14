#!/usr/bin/env bash
# 打包「驿站助手」重建版安卓 App（无需 Gradle / Android Studio）
# 依赖：JDK 17 + Android SDK 的 platform (android.jar) 与 build-tools
# 用法：bash android/build-apk.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP="$HERE/app/src/main"
BUILD="$HERE/build"
DIST="$HERE/dist"

W() { cygpath -w "$1"; }

SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-C:/android-build/sdk}}"
BT="$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1)"
PLATFORM="$(ls -d "$SDK"/platforms/android-* 2>/dev/null | sort -V | tail -1)"
ANDROID_JAR="$PLATFORM/android.jar"
JAVA_HOME="${JAVA_HOME:-C:/android-build/jdk/jdk17.0.21_0}"
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"
JAVAC="$JAVA_HOME/bin/javac"
KEYTOOL="$JAVA_HOME/bin/keytool"
JAR="$JAVA_HOME/bin/jar"

for f in "$ANDROID_JAR" "$JAVAC" "$BT/aapt2.exe" "$BT/d8.bat" "$BT/zipalign.exe" "$BT/apksigner.bat"; do
  [ -e "$f" ] || { echo "缺少工具：$f"; exit 1; }
done

echo "==> SDK: $SDK / build-tools: $BT"
rm -rf "$BUILD"
mkdir -p "$BUILD/gen" "$BUILD/classes" "$BUILD/dex" "$BUILD/assets" "$DIST"

# assets 只放根级文件：aapt2 在 Windows 下会把子目录写成反斜杠，AssetManager 读不到
echo "==> 同步网页资源"
for f in index.html styles.css rules.js db.js auth.js media.js app.js manifest.webmanifest sw.js; do
  cp "$ROOT/$f" "$BUILD/assets/$f"
done
mkdir -p "$BUILD/stage/assets/icons"
cp "$ROOT"/icons/*.png "$BUILD/stage/assets/icons/"

echo "==> aapt2 compile / link"
"$BT/aapt2.exe" compile --dir "$(W "$APP/res")" -o "$(W "$BUILD/res.zip")"
"$BT/aapt2.exe" link \
  -o "$(W "$BUILD/base.apk")" \
  -I "$(W "$ANDROID_JAR")" \
  --manifest "$(W "$APP/AndroidManifest.xml")" \
  -A "$(W "$BUILD/assets")" \
  --java "$(W "$BUILD/gen")" \
  --min-sdk-version 21 \
  --target-sdk-version 34 \
  --version-code 12 \
  --version-name 2.0.1 \
  "$(W "$BUILD/res.zip")"

echo "==> javac"
: > "$BUILD/sources.txt"
find "$APP/java" "$BUILD/gen" -name '*.java' | while read -r f; do W "$f" >> "$BUILD/sources.txt"; done
if ! "$JAVAC" -nowarn -encoding UTF-8 -source 8 -target 8 \
  -bootclasspath "$(W "$ANDROID_JAR")" -classpath "$(W "$ANDROID_JAR")" \
  -d "$(W "$BUILD/classes")" @"$(W "$BUILD/sources.txt")" > "$BUILD/javac.log" 2>&1; then
  echo "javac 失败："; cat "$BUILD/javac.log"; exit 1
fi

echo "==> d8"
: > "$BUILD/classes.txt"
find "$BUILD/classes" -name '*.class' | while read -r f; do W "$f" >> "$BUILD/classes.txt"; done
"$BT/d8.bat" --lib "$(W "$ANDROID_JAR")" --min-api 21 --output "$(W "$BUILD/dex")" @"$(W "$BUILD/classes.txt")"

echo "==> 写入 classes.dex 与图标"
( cd "$BUILD/dex" && "$JAR" uf "$(W "$BUILD/base.apk")" classes.dex )
( cd "$BUILD/stage" && "$JAR" uf "$(W "$BUILD/base.apk")" assets/icons )

echo "==> zipalign"
"$BT/zipalign.exe" -f -p 4 "$(W "$BUILD/base.apk")" "$(W "$BUILD/aligned.apk")"

KS="$HERE/debug.keystore"
if [ ! -f "$KS" ]; then
  echo "==> 生成调试密钥库"
  "$KEYTOOL" -genkeypair -v \
    -keystore "$(W "$KS")" -alias station \
    -storepass station2024 -keypass station2024 \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Station Assistant, OU=Rhua, O=Rhua, L=Beijing, ST=Beijing, C=CN" >/dev/null 2>&1
fi

APK="$DIST/station-assistant-2.0.1.apk"
echo "==> apksigner"
"$BT/apksigner.bat" sign \
  --ks "$(W "$KS")" --ks-pass pass:station2024 --key-pass pass:station2024 \
  --ks-key-alias station --v1-signing-enabled true --v2-signing-enabled true \
  --out "$(W "$APK")" "$(W "$BUILD/aligned.apk")"

echo "==> 校验签名"
"$BT/apksigner.bat" verify --print-certs "$(W "$APK")" | head -6
echo ""
echo "完成：$APK"
ls -lh "$APK"
