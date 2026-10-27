import { describe, expect, it } from "vitest";
import {
  META_SAM_URL,
  parseSam,
  parseSamVideo,
  parseSegmentation,
  parseSegmentationFrames,
  samBody,
  samVideoBody,
} from "./meta-sam";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// A payload in the shape SAM returned: base85, with "=", ":" and quotes inside it.
const PAYLOAD = "!!#35#UCIk6e2mKrlP4]4-hUSqZ6I/MU=vnTY.el.9T*?Gl)[Lkc=vb*xA#:oyF1!$'KM^*`u";

function answer(text: string, status = "completed") {
  return {
    id: "resp_6adfd00921adfa3e99bf4ca1",
    object: "response",
    status,
    model: "sam-3.1",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, images_processed: 1 },
    store: false,
  };
}

describe("samBody", () => {
  it("sends the phrase and the image inline, metadata as strings, nothing stored", () => {
    expect(META_SAM_URL).toBe("https://api.meta.ai/v1/responses");
    const body = samBody("sam-3.1", { mime: "image/png", bytes: PNG }, "paper document", {
      maskEncoding: "lossless",
      includeConfidence: true,
    });
    expect(body).toEqual({
      model: "sam-3.1",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "paper document" },
            {
              type: "input_image",
              image_url: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
            },
          ],
        },
      ],
      metadata: { mask_encoding: "lossless", include_confidence: "true" },
      store: false,
    });
    const plain = samBody("sam-3.1", { mime: "image/png", bytes: PNG }, "receipt", {
      maskEncoding: "one_bit",
      includeConfidence: false,
    });
    expect(plain.metadata).toEqual({ mask_encoding: "one_bit" });
  });
});

describe("parseSegmentation", () => {
  it("reads the documented example: one box, its mask, no confidence", () => {
    const text =
      "<0f>0<|box;x1=181;y1=365;x2=556;y2=486;w=1516;h=1600|><|mask;x=0;y=0;data=122,376,~AbC|>";
    expect(parseSegmentation(text)).toEqual({
      imageWidth: 1516,
      imageHeight: 1600,
      matches: [
        {
          box: { x1: 181, y1: 365, x2: 556, y2: 486 },
          mask: { x: 0, y: 0, height: 122, width: 376, encoding: "lossless", payload: "AbC" },
        },
      ],
    });
  });

  it("reads the measured shape: confidence on both tokens, a payload with = in it, a trailing newline", () => {
    const text =
      "<0f>0<|box;x1=120;y1=50;x2=279;y2=259;w=400;h=300;c=0.5816993117332458|>" +
      `<|mask;x=0;y=0;c=0.5816993117332458;data=210,160,~${PAYLOAD}|>\n`;
    expect(parseSegmentation(text)).toEqual({
      imageWidth: 400,
      imageHeight: 300,
      matches: [
        {
          box: { x1: 120, y1: 50, x2: 279, y2: 259 },
          confidence: 0.5816993117332458,
          mask: { x: 0, y: 0, height: 210, width: 160, encoding: "lossless", payload: PAYLOAD },
        },
      ],
    });
  });

  it("reads several records, fields in any order, and a one-bit mask", () => {
    const text =
      "<0f>0<|box;w=400;h=300;y1=1;x1=2;y2=30;x2=40;c=0.9|><|mask;y=1;x=2;data=29,38,!xyz|>" +
      "1<|box;x1=50;y1=60;x2=70;y2=80;w=400;h=300;c=0.25|><|mask;x=50;y=60;data=20,20,~q|>";
    const out = parseSegmentation(text);
    expect(out?.matches).toHaveLength(2);
    expect(out?.matches[0]).toEqual({
      box: { x1: 2, y1: 1, x2: 40, y2: 30 },
      confidence: 0.9,
      mask: { x: 2, y: 1, height: 29, width: 38, encoding: "one_bit", payload: "xyz" },
    });
    expect(out?.matches[1].confidence).toBe(0.25);
  });

  it("reads no matches as an empty list with no size", () => {
    expect(parseSegmentation("")).toEqual({ imageWidth: null, imageHeight: null, matches: [] });
    expect(parseSegmentation("<0f>\n")).toEqual({
      imageWidth: null,
      imageHeight: null,
      matches: [],
    });
  });

  it("refuses text that does not follow the grammar", () => {
    const box = "<|box;x1=1;y1=2;x2=3;y2=4;w=10;h=10|>";
    const mask = "<|mask;x=0;y=0;data=2,2,~ab|>";
    for (const bad of [
      "some prose before" + box + mask,
      // A mask with no box before it, or two masks for one box.
      mask,
      box + mask + mask,
      // Missing or repeated fields, a confidence over 1, a negative size.
      "<|box;x1=1;y1=2;x2=3;w=10;h=10|>" + mask,
      "<|box;x1=1;x1=1;y1=2;x2=3;y2=4;w=10;h=10|>" + mask,
      "<|box;x1=1;y1=2;x2=3;y2=4;w=10;h=10;c=1.5|>" + mask,
      "<|box;x1=1;y1=2;x2=3;y2=4;w=-10;h=10|>" + mask,
      // An unclosed token, a mask with no data or an unknown encoding marker.
      "<|box;x1=1;y1=2;x2=3;y2=4;w=10;h=10" + mask,
      box + "<|mask;x=0;y=0|>",
      box + "<|mask;x=0;y=0;data=2,2,#ab|>",
      // Two image sizes in one answer.
      box + mask + "<|box;x1=1;y1=2;x2=3;y2=4;w=20;h=10|>" + mask,
    ]) {
      expect(parseSegmentation(bad), bad).toBeNull();
    }
  });
});

describe("parseSam", () => {
  it("charges one image for a completed answer, matched or not", () => {
    const outcome = parseSam(answer(""), 200);
    expect(outcome).toEqual({
      kind: "answered",
      status: "ok",
      httpStatus: 200,
      upstreamId: "resp_6adfd00921adfa3e99bf4ca1",
      metered: { unit: "images", count: 1 },
      value: { imageWidth: null, imageHeight: null, matches: [] },
    });
  });

  it("is unknown when the answer is not completed or its text is not segmentation", () => {
    for (const json of [null, "text", answer("x", "incomplete"), answer("free text")]) {
      expect(parseSam(json, 200), JSON.stringify(json)).toEqual({
        kind: "unknown",
        category: "unknown",
        httpStatus: 200,
      });
    }
  });

  it("charges a completed answer with no output as no matches", () => {
    expect(parseSam({ status: "completed" }, 200)).toMatchObject({
      kind: "answered",
      metered: { unit: "images", count: 1 },
      value: { matches: [] },
    });
  });
});

// Three frame lines from the measured license plate answer on the synthetic dock clip (frames 32,
// 33 and 57 of 144; every frame with no match is left out of the answer).
const PLATE_LINES = [
  "<32f>0<|box;x1=232;y1=237;x2=406;y2=300;w=640;h=360;c=0.8632478713989258|><|mask;x=0;y=0;c=0.8632478713989258;data=64,175,!!!!!OI70r'(Q)w`MO#?svHEcP&a[R2RC3@z%lH+wW'3sJ({l[aE9FjR!!|>",
  "<33f>0<|box;x1=231;y1=237;x2=406;y2=301;w=640;h=360;c=0.8632478713989258|><|mask;x=0;y=0;c=0.8632478713989258;data=65,176,!!!!!ZH3bkT:N^a755knHn3bE2!vioR/u.sd^P_vAA3=5kk`NAJMbl'1[fs/*kg7jVo&oEW|>",
  "<57f>0<|box;x1=158;y1=112;x2=219;y2=174;w=640;h=360;c=0.8632478713989258|><|mask;x=0;y=0;c=0.8632478713989258;data=63,62,!!!!!jEbTeynrG%5guCO(DwzkpKN1Hpluy@qk#*S.s7m9E?Oa1FBOylyl(Ky+X@u?M?txm9cxc6F$Ow(:lKAHQ:K/A|>",
];

function videoAnswer(text: string, usage: unknown = { video_frames_processed: 144 }, status = "completed") {
  return {
    id: "resp_video",
    status,
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    usage,
    store: false,
  };
}

describe("samVideoBody", () => {
  it("sends the phrase and the clip inline with the tracking settings as strings, nothing stored", () => {
    const bytes = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);
    expect(
      samVideoBody("sam-3.1", { bytes }, "license plate", {
        maskEncoding: "one_bit",
        includeConfidence: true,
        propagation: "both",
      }),
    ).toEqual({
      model: "sam-3.1",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "license plate" },
            { type: "input_video", video_url: `data:video/mp4;base64,${Buffer.from(bytes).toString("base64")}` },
          ],
        },
      ],
      metadata: { mask_encoding: "one_bit", include_confidence: "true", propagation_direction: "both" },
      store: false,
    });
  });
});

describe("parseSegmentationFrames", () => {
  it("reads the measured lines: frames from 0, boxes in the clip's pixels, one size", () => {
    const answer = parseSegmentationFrames(PLATE_LINES.join("\n"), 143);
    expect(answer).not.toBeNull();
    expect([...answer!.frames.keys()]).toEqual([32, 33, 57]);
    expect(answer!.width).toBe(640);
    expect(answer!.height).toBe(360);
    expect(answer!.frames.get(32)![0].box).toEqual({ x1: 232, y1: 237, x2: 406, y2: 300 });
    expect(answer!.frames.get(57)![0].box).toEqual({ x1: 158, y1: 112, x2: 219, y2: 174 });
    expect(answer!.frames.get(33)![0].confidence).toBeCloseTo(0.8632, 4);
  });

  it("reads an answer with no frames as nothing matched", () => {
    expect(parseSegmentationFrames("", 143)).toEqual({ frames: new Map(), width: null, height: null });
  });

  it("refuses a frame past the clip, a repeated frame and text before the first frame", () => {
    expect(parseSegmentationFrames(PLATE_LINES.join("\n"), 56)).toBeNull();
    expect(parseSegmentationFrames([PLATE_LINES[0], PLATE_LINES[0]].join("\n"), 143)).toBeNull();
    expect(parseSegmentationFrames(`note ${PLATE_LINES[0]}`, 143)).toBeNull();
  });
});

describe("parseSamVideo", () => {
  it("charges the frames the provider processed", () => {
    const outcome = parseSamVideo(143)(videoAnswer(PLATE_LINES.join("\n")), 200);
    expect(outcome).toMatchObject({
      kind: "answered",
      status: "ok",
      upstreamId: "resp_video",
      metered: { unit: "video_frames", count: 144 },
      value: { width: 640, height: 360, framesProcessed: 144 },
    });
  });

  it("is unknown without a positive whole frame count, when not completed, or when the text does not parse", () => {
    const parse = parseSamVideo(143);
    for (const json of [
      videoAnswer("", {}),
      videoAnswer("", { video_frames_processed: 0 }),
      videoAnswer("", { video_frames_processed: 1.5 }),
      videoAnswer("", { video_frames_processed: "144" }),
      videoAnswer("", null),
      videoAnswer("", { video_frames_processed: 144 }, "incomplete"),
      videoAnswer("free text"),
      null,
    ]) {
      expect(parse(json, 200), JSON.stringify(json)).toEqual({ kind: "unknown", category: "unknown", httpStatus: 200 });
    }
  });
});
