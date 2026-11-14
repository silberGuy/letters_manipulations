import { useRef, useState } from "react";
import { renderRecipe } from "../core/pipeline";
import { rasterToPngBlob } from "../core/raster";
import { assetResolver } from "../store/assets";
import { loadBundle, saveBundle } from "../store/bundle";
import { sourceSpacingSchema, type Source } from "../core/recipe";
import { useStore } from "../store/store";
import {
	vectorize,
	vectorizeOptionsSchema,
	type VectorizeOptions,
} from "../vectorize/vectorize";
import { ControlsPanel } from "./ControlsPanel";
import { download, timestamp } from "./download";

/** Save, Load, Export and Trace settings, at the bottom of the left sidebar. */
export function FileActions() {
	const loadRecipe = useStore((s) => s.loadRecipe);
	const source = useStore((s) => s.recipe.source);
	const setSource = useStore((s) => s.setSource);
	const setShowExportBounds = useStore((s) => s.setShowExportBounds);
	const fileInput = useRef<HTMLInputElement>(null);
	const [traceOptions, setTraceOptions] = useState<VectorizeOptions>(() =>
		vectorizeOptionsSchema.parse({}),
	);
	const [busy, setBusy] = useState<string | null>(null);

	const run = (label: string, task: () => Promise<void>) => async () => {
		setBusy(label);
		try {
			await task();
		} catch (e) {
			console.error(e);
			alert(`${label} failed: ${e instanceof Error ? e.message : e}`);
		} finally {
			setBusy(null);
		}
	};

	const save = run("Save", async () => {
		const recipe = await useStore.getState().reconcile();
		download(
			await saveBundle(recipe, useStore.getState().assetBlobs),
			`letters-${timestamp()}.zip`,
		);
	});

	const exportPng = run("Export PNG", async () => {
		const output = await renderRecipe(
			await useStore.getState().reconcile(),
			assetResolver,
		);
		download(
			await rasterToPngBlob(output.raster),
			`letters-${timestamp()}.png`,
		);
	});

	const exportSvg = run("Export SVG", async () => {
		const output = await renderRecipe(
			await useStore.getState().reconcile(),
			assetResolver,
		);
		const traced = !output.svg;
		const svg =
			typeof output.svg === "function"
				? await output.svg()
				: (output.svg ?? (await vectorize(output.raster, traceOptions)));
		download(
			new Blob([svg], { type: "image/svg+xml" }),
			`letters-${timestamp()}${traced ? "-traced" : ""}.svg`,
		);
	});

	return (
		<div className="file-actions row">
			<button type="button" className="btn" onClick={save}>
				Save
			</button>
			<button
				type="button"
				className="btn"
				onClick={() => fileInput.current?.click()}
			>
				Load
			</button>
			<input
				ref={fileInput}
				type="file"
				accept=".zip,application/zip"
				hidden
				onChange={(e) => {
					const file = e.target.files?.[0];
					e.target.value = "";
					if (!file) return;
					run("Load", async () => {
						const { recipe, assetBlobs, warnings } = await loadBundle(file);
						loadRecipe(recipe, assetBlobs, warnings);
					})();
				}}
			/>
			<details
				className="popover"
				onToggle={(e) => setShowExportBounds(e.currentTarget.open)}
			>
				<summary className="btn summary">Export</summary>
				<div className="popover-body stack">
					<p className="hint muted">
						The outline on the canvas shows what will be exported.
					</p>
					<ControlsPanel
						schema={sourceSpacingSchema}
						owner="export spacing"
						values={source}
						onChange={(v) => setSource(v as Partial<Source>)}
					/>
					<div className="row">
						<button type="button" className="btn" onClick={exportPng}>
							PNG
						</button>
						<button type="button" className="btn" onClick={exportSvg}>
							SVG
						</button>
					</div>
				</div>
			</details>
			<details className="popover">
				<summary
					className="btn summary"
					title="Used when the Manipulation has no native vector output"
				></summary>
				<div className="popover-body">
					<p className="hint muted">
						Used when the Manipulation has no native vector, so the SVG is
						traced from pixels.
					</p>
					<ControlsPanel
						schema={vectorizeOptionsSchema}
						owner="vectorize"
						values={traceOptions}
						onChange={(v) => setTraceOptions(v as VectorizeOptions)}
					/>
				</div>
			</details>
			{busy && <span className="muted">{busy}…</span>}
		</div>
	);
}
