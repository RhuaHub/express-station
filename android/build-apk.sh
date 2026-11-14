#!/usr/bin/env bash
# 打包快递驿站安卓 App（无需 Gradle / Android Studio）
# 依赖：JDK 17 + Android SDK 的 platform (android.jar) 与 build-tools
# 用法：bash android/build-apk.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP="$HERE/app/src/main"
BUILD="$HERE/build"
DIST="$HERE/dist"

# Windows 可执行文件不认 /c/... 形式，统一转换
W() { cygpath -w "$1"; }

# ---- 工具链定位 ----
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

echo "==> SDK: $SDK"
echo "==> build-tools: $BT"
echo "==> platform: $PLATFORM"
echo "==> JDK: $JAVA_HOME"

rm -rf "$BUILD"
mkdir -p "$BUILD/gen" "$BUILD/classes" "$BUILD/dex" "$BUILD/assets" "$DIST"

# ---- 1. 同步网页资源到 assets ----
# 注意：aapt2 在 Windows 下会把子目录写成反斜杠路径，AssetManager 将无法读取，
# 因此 assets 只放根级文件，图标改由 jar 以正斜杠补入（见步骤 5）。
echo "==> 同步网页资源"
for f in index.html styles.css app.js assistant.js store.js auth.js photos.js camera.js recognize.js sync.js manifest.webmanifest; do
  cp "$ROOT/$f" "$BUILD/assets/$f"
done
mkdir -p "$BUILD/stage/assets/icons"
cp "$ROOT"/icons/*.png "$BUILD/stage/assets/icons/"

# ---- 2. 编译资源 ----
echo "==> aapt2 compile"
"$BT/aapt2.exe" compile --dir "$(W "$APP/res")" -o "$(W "$BUILD/res.zip")"

echo "==> aapt2 link"
"$BT/aapt2.exe" link \
  -o "$(W "$BUILD/base.apk")" \
  -I "$(W "$ANDROID_JAR")" \
  --manifest "$(W "$APP/AndroidManifest.xml")" \
  -A "$(W "$BUILD/assets")" \
  --java "$(W "$BUILD/gen")" \
  --min-sdk-version 21 \
  --target-sdk-version 34 \
  --version-code 7 \
  --version-name 1.1.0 \
  "$(W "$BUILD/res.zip")"

# ---- 3. 编译 Java ----
echo "==> javac"
: > "$BUILD/sources.txt"
find "$APP/java" "$BUILD/gen" -name '*.java' | while read -r f; do W "$f" >> "$BUILD/sources.txt"; done
if ! "$JAVAC" -nowarn -encoding UTF-8 -source 8 -target 8 \
  -bootclasspath "$(W "$ANDROID_JAR")" -classpath "$(W "$ANDROID_JAR")" \
  -d "$(W "$BUILD/classes")" @"$(W "$BUILD/sources.txt")" > "$BUILD/javac.log" 2>&1; then
  echo "javac 失败："; cat "$BUILD/javac.log"; exit 1
fi

# ---- 4. dex ----
echo "==> d8"
: > "$BUILD/classes.txt"
find "$BUILD/classes" -name '*.class' | while read -r f; do W "$f" >> "$BUILD/classes.txt"; done
"$BT/d8.bat" --lib "$(W "$ANDROID_JAR")" --min-api 21 --output "$(W "$BUILD/dex")" @"$(W "$BUILD/classes.txt")"

# ---- 5. 打包 dex 与图标 ----
echo "==> 写入 classes.dex 与 assets/icons"
( cd "$BUILD/dex" && "$JAR" uf "$(W "$BUILD/base.apk")" classes.dex )
( cd "$BUILD/stage" && "$JAR" uf "$(W "$BUILD/base.apk")" assets/icons )

# ---- 6. 对齐 ----
echo "==> zipalign"
"$BT/zipalign.exe" -f -p 4 "$(W "$BUILD/base.apk")" "$(W "$BUILD/aligned.apk")"

# ---- 7. 签名（首次自动生成调试密钥库）----
KS="$HERE/debug.keystore"
if [ ! -f "$KS" ]; then
  echo "==> 生成调试密钥库"
  "$KEYTOOL" -genkeypair -v \
    -keystore "$(W "$KS")" -alias station \
    -storepass station2024 -keypass station2024 \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Express Station, OU=Rhua, O=Rhua, L=Beijing, ST=Beijing, C=CN" >/dev/null 2>&1
fi

APK="$DIST/express-station-1.1.0.apk"
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
