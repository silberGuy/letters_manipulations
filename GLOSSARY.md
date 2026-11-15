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

**Press**:
A point the user held down in a Manipulation's editor, stored in State with how long it was held; render grows its effect from the point for that duration.
_Avoid_: Click, tap, touch

**Blade**:
One grass stroke the Grass Manipulation grows out of a letter's edge: a tapered curve pointing away from the ink, with a random tilt and bend.
_Avoid_: Hair, spike, line

**Cut**:
A stroke the user dragged in a Manipulation's editor, stored in State as timed points; render opens ellipses along it as they were reached in time.
_Avoid_: Slash, line, path

**Grid Point**:
A corner of the grid laid over the image in a Manipulation's editor; the user drags Grid Points, alone or box-selected together, and render maps each cell bilinearly onto the quad of its moved corners. Stored in State as its rest position and offset.
_Avoid_: Node, vertex, handle

**Crack**:
A break the Crack Manipulation opens across the whole image, edge to edge: the two sides move apart rigidly, leaving a jagged gap that is thin at one end and wide at the other. Stored in State as its line, end widths and the click it follows. Not the hairline cracks Shoot draws around its holes.
_Avoid_: Split, rift, fault

**Displacement**:
How a Step moves points from its input to its Output (e.g. a Crack pushing each side away). When a Step's Displacement changes, the State of later Steps moves with it, and edits of the Source are carried through it.
_Avoid_: Warp, deformation

**Canvas**:
The area of the interface where a Manipulation's editor shows its image and takes the user's presses, including the empty margin around the image.
_Avoid_: Editor, viewport, stage

**Interface Break**:
A short-lived disturbance of the interface itself (not the image) that a Manipulation's editor sets off during a gesture, such as a shake, or bullet holes and cracks appearing over the UI. By default it looks like the marks its Manipulation leaves on the image. The interface stays usable while broken, and each break then repairs itself in its own way. Never part of the Recipe or the Output.
_Avoid_: Effect, glitch, screen effect

**Asset**:
A user-supplied file (e.g. an uploaded image) that a Recipe refers to by content hash and carries with it.
_Avoid_: Attachment, upload, resource

**Output**:
The image a Step produces from its input; always raster, optionally also vector. The Recipe's Output is its last Step's Output.
_Avoid_: Result, export, render

**Export**:
The UI action that saves an Output to a file (PNG, SVG). Manipulations produce Outputs; they never export.
_Avoid_: Output, download, save
