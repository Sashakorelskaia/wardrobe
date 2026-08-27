// Background removal that runs on the visitor's own device.
// WebGPU when available, WebAssembly otherwise. Nothing is uploaded anywhere.

import {
  AutoModel,
  AutoProcessor,
  RawImage,
  env,
} from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js";

env.allowLocalModels = false;

const MODEL_ID = "briaai/RMBG-1.4";

let ready = null;
let backend = null;

async function hasWebGPU() {
  if (!navigator.gpu) return false;
  try {
    return Boolean(await navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

/** Load the model once. `onProgress` gets {status, progress, file} straight from the loader. */
export function init(onProgress) {
  if (ready) return ready;

  ready = (async () => {
    const webgpu = await hasWebGPU();
    backend = webgpu ? "webgpu" : "wasm";

    const model = await AutoModel.from_pretrained(MODEL_ID, {
      config: { model_type: "custom" },
      dtype: "fp32",
      device: backend,
      progress_callback: onProgress,
    });

    // RMBG-1.4 ships no preprocessor config, so it is spelled out here.
    const processor = await AutoProcessor.from_pretrained(MODEL_ID, {
      config: {
        do_normalize: true,
        do_pad: false,
        do_rescale: true,
        do_resize: true,
        image_mean: [0.5, 0.5, 0.5],
        image_std: [1, 1, 1],
        feature_extractor_type: "ImageFeatureExtractor",
        resample: 2,
        rescale_factor: 1 / 255,
        size: { width: 1024, height: 1024 },
      },
    });

    return { model, processor };
  })();

  return ready;
}

export function backendName() {
  return backend;
}

/**
 * Take a canvas with the raw photo, return a new canvas with the background
 * knocked out to transparency.
 */
export async function removeBackground(sourceCanvas) {
  const { model, processor } = await init();

  const image = await RawImage.fromCanvas(sourceCanvas);
  const { pixel_values } = await processor(image);
  const { output } = await model({ input: pixel_values });

  const mask = await RawImage.fromTensor(output[0].mul(255).to("uint8")).resize(
    sourceCanvas.width,
    sourceCanvas.height
  );

  const out = document.createElement("canvas");
  out.width = sourceCanvas.width;
  out.height = sourceCanvas.height;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(sourceCanvas, 0, 0);

  const img = ctx.getImageData(0, 0, out.width, out.height);
  for (let i = 0; i < mask.data.length; i++) {
    img.data[i * 4 + 3] = mask.data[i];
  }
  ctx.putImageData(img, 0, 0);
  return out;
}
