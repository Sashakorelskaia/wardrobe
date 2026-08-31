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
    // Two different limits, so two different builds of the same model.
    //
    // Desktop with a GPU: fp16, 84 MB, runs on the graphics card in about a
    // second. Quantized weights cannot run there and would fall back to the
    // slow path, so they are not used when a GPU is available.
    //
    // Phone: memory is the binding constraint — full weights are 167 MB and
    // iOS kills the tab before they finish loading. Quantized is 42 MB and
    // survives, on the CPU path, slower but finishing.
    const smallScreen = Math.min(screen.width, screen.height) <= 500;
    const webgpu = !smallScreen && (await hasWebGPU());
    backend = webgpu ? "webgpu" : "wasm";
    const dtype = webgpu ? "fp16" : "q8";

    const model = await AutoModel.from_pretrained(MODEL_ID, {
      config: { model_type: "custom" },
      dtype,
      device: backend,
      progress_callback: onProgress,
    });

    // RMBG-1.4 ships no preprocessor config, so it is spelled out here.
    // Inference cost scales with the square of this size: 768 uses roughly
    // half the memory of 1024, which is the difference between finishing and
    // having the tab killed on a phone. A garment silhouette survives it.
    const side = smallScreen ? 768 : 1024;

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
        size: { width: side, height: side },
      },
    });

    return { model, processor };
  })();

  return ready;
}


/**
 * The quantized model misclassifies scattered pixels, which show up as white
 * specks on a dark garment and stray crumbs of background around it. Two cheap
 * passes fix what a bigger model would not have produced in the first place.
 */

/** Median of each 3×3 neighbourhood: removes lone specks, keeps edges sharp. */
function medianFilter(data, w, h) {
  const out = new Uint8Array(data.length);
  const win = new Uint8Array(9);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          win[n++] = data[yy * w + xx];
        }
      }
      const slice = win.subarray(0, n);
      slice.sort();
      out[y * w + x] = slice[n >> 1];
    }
  }
  return out;
}

/**
 * Drop islands smaller than `minFraction` of the frame — both floating scraps
 * of background and pinholes punched through the garment.
 */
function removeSmallIslands(data, w, h, minFraction = 0.0015) {
  const minSize = Math.max(24, Math.round(w * h * minFraction));
  const seen = new Uint8Array(data.length);
  const stack = new Int32Array(data.length);
  const region = new Int32Array(data.length);

  for (let start = 0; start < data.length; start++) {
    if (seen[start]) continue;
    const solid = data[start] > 127;
    let top = 0, count = 0;
    stack[top++] = start;
    seen[start] = 1;

    while (top > 0) {
      const i = stack[--top];
      region[count++] = i;
      const x = i % w, y = (i / w) | 0;
      const neighbours = [
        x > 0 ? i - 1 : -1,
        x < w - 1 ? i + 1 : -1,
        y > 0 ? i - w : -1,
        y < h - 1 ? i + w : -1,
      ];
      for (const j of neighbours) {
        if (j < 0 || seen[j]) continue;
        if (data[j] > 127 === solid) {
          seen[j] = 1;
          stack[top++] = j;
        }
      }
    }

    if (count < minSize) {
      const flip = solid ? 0 : 255;
      for (let k = 0; k < count; k++) data[region[k]] = flip;
    }
  }
  return data;
}

export function cleanMask(mask, w, h) {
  const filtered = medianFilter(mask, w, h);
  return removeSmallIslands(filtered, w, h);
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
  const cleaned = cleanMask(mask.data, sourceCanvas.width, sourceCanvas.height);

  const out = document.createElement("canvas");
  out.width = sourceCanvas.width;
  out.height = sourceCanvas.height;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(sourceCanvas, 0, 0);

  const img = ctx.getImageData(0, 0, out.width, out.height);
  for (let i = 0; i < cleaned.length; i++) {
    img.data[i * 4 + 3] = cleaned[i];
  }
  ctx.putImageData(img, 0, 0);
  return out;
}
