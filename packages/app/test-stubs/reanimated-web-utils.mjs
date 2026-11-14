// Vite leaves Reanimated's optional CommonJS requires inside unbundled ESM.
// Forward the same real web helpers; animations and their DOM updates remain active.
export { default as createReactDOMStyle } from "react-native-web/dist/exports/StyleSheet/compiler/createReactDOMStyle";
export {
  createTransformValue,
  createTextShadowValue,
} from "react-native-web/dist/exports/StyleSheet/preprocess";
