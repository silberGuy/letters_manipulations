# Manipulations operate on raster images, not glyph outlines

Every Manipulation takes an RGBA raster as input and produces an Output that always contains a raster (vector is optional). The Source is the user's text rasterized in the chosen font. We chose this over handing Manipulations glyph outlines so that Manipulations share one input/output type and can later be chained into a sequence of Steps, each consuming the previous Output. The cost is that vector-native effects must first trace the raster (via the shared vectorize util) rather than reading font outlines directly, and the result is resolution-bound — so a Recipe fixes the Source's pixel size.

We rasterize the Source with the browser's own text rendering rather than our own outline rasterizer, so a Recipe reproduces exactly only on the same browser and OS; across browsers, anti-aliasing may differ by a few edge pixels. We accepted this to avoid writing our own text layout and bidi handling.
