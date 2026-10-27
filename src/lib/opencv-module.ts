import * as cvNamespace from "@techstark/opencv-js";

// Keep the Promise-like runtime behind a namespace so dynamic import won't assimilate it.
const cvModule = (cvNamespace as unknown as { default?: unknown }).default ?? cvNamespace;

export default cvModule;
