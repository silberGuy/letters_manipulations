# Letters Manipulations

A tool for typing words in a chosen font, transforming them visually, and exporting the result as an image.

## Language

**Source**:
The starting image: the user's text set in a chosen font, rasterized.
_Avoid_: Input image, base, original

**Manipulation**:
A kind of visual transformation, defined by its controls, its interactive editor, and a deterministic render.
_Avoid_: Effect, filter, transform, plugin

**Recipe**:
A stored, serializable record of everything needed to reproduce an Output exactly, including the seed.
_Avoid_: Take, variant, preset, history entry

**Step**:
One application of a Manipulation within a Recipe, with its own params, state and seed.
_Avoid_: Layer, pass, stage

**Params**:
The values of a Step that its render reads and that can be set from outside the Manipulation's editor (e.g. color, strength). Part of the Recipe.
_Avoid_: Options, settings, config

**State**:
The data a Step accumulates through direct interaction with the Manipulation's editor (e.g. strokes, dragged points). Part of the Recipe.
_Avoid_: Data, interaction log

**Tool settings**:
Values that shape how the user interacts with a Manipulation's editor (e.g. brush size) but that render never reads. Not part of the Recipe; their effect lives on in the State they produce.
_Avoid_: Params, UI state

**Asset**:
A user-supplied file (e.g. an uploaded image) that a Recipe refers to by content hash and carries with it.
_Avoid_: Attachment, upload, resource

**Output**:
The image a Manipulation produces from its input; always raster, optionally also vector.
_Avoid_: Result, export, render
