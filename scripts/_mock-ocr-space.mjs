const OCR_SPACE_ENDPOINT = "https://api.ocr.space/parse/image";
const fetch = globalThis.fetch;

globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url !== OCR_SPACE_ENDPOINT) return fetch(input, init);

  return Promise.resolve(
    Response.json({
      OCRExitCode: 1,
      ParsedResults: [
        {
          ParsedText: "",
          TextOverlay: { Lines: [] },
        },
      ],
    })
  );
};
