import { useCallback, useMemo } from "react";
import { WebView } from "react-native-webview";
import { StyleSheet } from "react-native-unistyles";
import { staticOfficeDocument } from "./model";
const whitelist = ["*"];
export function OfficeFrame({ html, zoom = 1 }: { html: string; zoom?: number }) {
  const source = useMemo(
    () => ({ html: staticOfficeDocument(html, zoom), baseUrl: "about:blank" }),
    [html, zoom],
  );
  const allowInitialOnly = useCallback(({ url }: { url: string }) => url === "about:blank", []);
  return (
    <WebView
      source={source}
      testID="office-file-frame"
      style={styles.frame}
      originWhitelist={whitelist}
      onShouldStartLoadWithRequest={allowInitialOnly}
      javaScriptEnabled={false}
      domStorageEnabled={false}
      thirdPartyCookiesEnabled={false}
      javaScriptCanOpenWindowsAutomatically={false}
      setSupportMultipleWindows={false}
      cacheEnabled={false}
      incognito
    />
  );
}
const styles = StyleSheet.create({ frame: { flex: 1, minHeight: 0, backgroundColor: "white" } });
