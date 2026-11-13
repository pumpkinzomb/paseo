import { useMemo } from "react";
import { staticOfficeDocument } from "./model";
const style = {
  flex: 1,
  minHeight: 0,
  width: "100%",
  border: "none",
  backgroundColor: "white",
} as const;

/** Parse into an inert template, strip active/navigation markup, then render under a full sandbox. */
export function sanitizedOfficeHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const element of template.content.querySelectorAll(
    "script,meta,base,iframe,frame,object,embed,link,form,input,button,video,audio,source,svg,math",
  ))
    element.remove();
  for (const element of template.content.querySelectorAll("*")) {
    for (const attributeName of element.getAttributeNames()) {
      const name = attributeName.toLowerCase();
      const value = element.getAttribute(attributeName) ?? "";
      const image =
        element.tagName === "IMG" &&
        name === "src" &&
        /^data:image\/(png|jpeg|gif|webp);base64,/i.test(value);
      const active =
        name.startsWith("on") ||
        ["href", "src", "srcset", "xlink:href", "action", "formaction", "target"].includes(name);
      if (active && !image) element.removeAttribute(attributeName);
    }
  }
  return template.innerHTML;
}
export function OfficeFrame({ html, zoom = 1 }: { html: string; zoom?: number }) {
  const source = useMemo(
    () =>
      `data:text/html;charset=utf-8,${encodeURIComponent(staticOfficeDocument(sanitizedOfficeHtml(html), zoom))}`,
    [html, zoom],
  );
  return (
    <iframe
      title="Office file preview"
      data-testid="office-file-frame"
      src={source}
      sandbox=""
      referrerPolicy="no-referrer"
      style={style}
    />
  );
}
