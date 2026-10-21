/** One physical button on a mouse drawing. Coordinates are in the model's viewBox space. */
export interface ModelButton {
  /** 1 left, 2 right, 3 middle, 4 back (X1), 5 forward (X2). Higher ids need HID report support. */
  id: number;
  label: string;
  defaultAction: string;
  /** Centre of the numbered badge. */
  badge: [number, number];
  /** Point on the drawing the leader line ends at. */
  target: [number, number];
  /** Optional outline of the button, drawn filled when the button is pressed. */
  shape?: string;
  /** False when Windows never reports this button (for example a DPI button). */
  detectable?: boolean;
}

export interface MouseModel {
  id: string;
  name: string;
  viewBox: [number, number];
  /** SVG path data for the line drawing. */
  outline: string;
  buttons: ModelButton[];
}
