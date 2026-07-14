export const MIN_READER_WIDTH = 300;
export const MIN_CATALOG_WIDTH = 360;
export const RESIZER_WIDTH = 11;

export function maximumReaderWidth(viewportWidth) {
	return Math.max(MIN_READER_WIDTH, viewportWidth - MIN_CATALOG_WIDTH - RESIZER_WIDTH);
}

export function defaultReaderWidth(viewportWidth) {
	return Math.round(viewportWidth * 0.34);
}

export function clampReaderWidth(width, viewportWidth) {
	return Math.round(
		Math.min(maximumReaderWidth(viewportWidth), Math.max(MIN_READER_WIDTH, width)),
	);
}

export function readerWidthFromPointer(startWidth, startPointerX, currentPointerX, viewportWidth) {
	return clampReaderWidth(startWidth + startPointerX - currentPointerX, viewportWidth);
}

export function readerWidthFromKey(key, currentWidth, viewportWidth, accelerated) {
	const step = accelerated ? 64 : 24;
	if (key === "ArrowLeft") return clampReaderWidth(currentWidth + step, viewportWidth);
	if (key === "ArrowRight") return clampReaderWidth(currentWidth - step, viewportWidth);
	if (key === "Home") return MIN_READER_WIDTH;
	if (key === "End") return maximumReaderWidth(viewportWidth);
	return null;
}
