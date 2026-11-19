export type ViewerCommentLoad<Row> = { rows: Row[]; canComment: boolean };

export type ViewerCommentSource<Row> = {
  document: () => Promise<{ access?: string } | undefined>;
  list: () => Promise<Row[]>;
  onError: (error: unknown) => void;
};

const degraded = <Row>(): ViewerCommentLoad<Row> => ({ rows: [], canComment: false });

export async function loadViewerComments<Row>(source: ViewerCommentSource<Row>): Promise<ViewerCommentLoad<Row>> {
  try {
    const shared = await source.document();
    if (shared === undefined) return degraded<Row>();
    return { rows: await source.list(), canComment: shared.access !== "reader" };
  } catch (error) {
    source.onError(error);
    return degraded<Row>();
  }
}
