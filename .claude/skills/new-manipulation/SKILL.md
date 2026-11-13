---
name: new-manipulation
description: Create a new Manipulation (a visual transformation of the lettering) in this repo. Use when the user wants to add an effect, transformation, or interactive tool to the app, or says "new manipulation".
---

# Creating a Manipulation

Read `GLOSSARY.md` first and use its terms (Manipulation, Step, Params, State, Tool settings, Output, Recipe, Asset). Read `docs/adr/` for constraints. The contract lives in `src/core/manipulation.ts`; the existing Manipulations in `src/manipulations/` are the reference examples:

- `skew.tsx`: Params only, Output changes size, uses canvas transforms.
- `goo.tsx`: Params only, pixel processing on coverage, uses the shared blur.
- `hole.tsx`: interactive. Clicks write State, and a Tool setting controls the size.

## 1. Pin down the design with the user

Before writing code, settle these (ask about anything the request leaves open):

1. **What render does.** It takes RGBA `ImageData` and returns `{ raster: ImageData; svg?: string | (() => Promise<string>) }`.
2. **Classify every input** using one rule: *if render reads it, it belongs in the Recipe (Params or State); if only the editor reads it, it's a Tool setting.*
   - **Params** are values set from the side panel, or by on-canvas handles through `setParams` (e.g. strength, colour, angle).
   - **State** is data produced by interacting with the canvas (e.g. points, strokes, holes).
   - **Tool settings** shape the interaction only (e.g. brush size). Their effect must be recorded *into* State (each stroke stores its own width), never read by render.
3. **Randomness.** If render needs any, it uses `rng`.
4. **Vector output.** If render returns no `svg`, the SVG Export (`src/ui/TopBar.tsx`) traces the raster Output with `vectorize()`, and only when the user exports. So "raster plus a traced SVG" needs no code and no question to the user. Only ask when the Manipulation could produce a *native* SVG (it may call `vectorize()` itself, e.g. to trace the input and add vector shapes on top). If building the SVG is costly (e.g. it traces), return it as a function: it's only called on export, never for the live preview.

## 2. Write `src/manipulations/<id>.tsx`

```tsx
const paramsSchema = z.object({ /* numberField, enumField, booleanField, colorField, pointField, imageField */ });
const stateSchema = z.object({ /* every field with .default(...) */ });
const toolsSchema = z.object({ /* field helpers */ });

async function render({ input, params, state, rng, assets }: RenderContext<Params, State>) { ... }

export const myThing = defineManipulation({
  id: 'my-thing', version: 1, label: 'My Thing',
  paramsSchema, stateSchema, toolsSchema, render,
  Component: (props) => <PreviewEditor {...props} render={render} />, // or a custom editor
});
```

Then add it to `MANIPULATIONS` in `src/manipulations/index.ts`. That file checks every schema when the app starts.

### Rules that keep Recipes reproducible

- **Deterministic render.** The output depends only on `input`, `params`, `state`, `rng` and `assets`. Never use `Math.random`, `Date`, module-level mutable state, or the DOM.
- **Randomness.** Use `rng`, and use `rng.fork('label')` to give each independent random feature its own stream, so adding a feature later doesn't shift the existing ones.
- **Never mutate `input`.** Copy it with `cloneRaster()` or draw it onto a new canvas.
- **Schemas.**
  - Use the field helpers in `src/core/fields.ts` for Params and Tool settings, because they carry the UI hints in `.meta()`.
  - Supported control types: number, boolean, enum, colour, point, image. Any other type throws at startup; to support a new one, extend `describeFields` and `ControlsPanel`.
  - Every field in all three schemas needs a default, because `schema.parse({})` must produce the initial values.
- **Coordinates in State** are normalized to the Step's input: `x / input.width`, `y / input.height`, and sizes relative to `input.width`.
- **Output size** may differ from the input (grow to fit rather than clip). If it does, a custom editor has to map pointer coordinates back to input space.
- **Ink convention.** The Source is black ink on transparent paper, with alpha as the coverage. Mask-style effects should read `coverage(input)` and write with `inkFromCoverage()` from `src/core/raster.ts`. All effects must still accept arbitrary RGBA input, since a future chain may feed them colour.
- **Helpers** to reuse:
  - `gaussianBlur` / `blurMargin` (`src/core/blur.ts`)
  - `rasterToCanvas`, `context2d`, `createRaster` (`src/core/raster.ts`)
  - `vectorize` and `vectorizeOptionsSchema` (`src/vectorize/vectorize.ts`). To vectorize inside render, spread `vectorizeOptionsSchema.shape` into `paramsSchema` so the settings are saved in the Recipe.
  - Image Params give `{ asset: hash } | null`. Read the pixels with `await assets.getImageData(ref.asset)`.

### Interactive editors

Copy the pattern in `hole.tsx`:

- Call `useRender(render, input, params, state, seed, assets)` to get the preview; it handles debouncing and stale results.
- Display it with `RasterView`. Pointer handlers receive image-pixel coordinates, and `overlay` is SVG drawn in image pixels (cursor previews, handles).
- **Gestures.** Keep an in-progress gesture (a drag, a stroke) in local `useState` and draw it as an overlay. Call `setState` once, when the gesture ends. Don't write to State on every pointermove.
- Always use the functional form for updates: `setState(s => ({ ...s, ... }))`.

## 3. Versioning existing Manipulations

When you change an existing Manipulation's render in a way that makes old Recipes look different, bump `version`. Loading an older Recipe then shows a warning. Pure refactors don't need a bump.

## 4. Finish

- Add any new domain term to `GLOSSARY.md`, using the domain-modeling conventions.
- Don't run npm commands; tell the user to run `npm run typecheck` and `npm run dev`.
- Don't write tests or do browser testing unless asked.
