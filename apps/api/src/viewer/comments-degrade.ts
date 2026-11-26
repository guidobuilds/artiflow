import { artifactPermissions, type ArtifactPermissions } from "@artiflow/domain/comment-permissions";

export type ViewerCommentLoad<Row> = { rows: Row[]; canComment: boolean; deleteAny: boolean };

export type ViewerCommentSource<Row> = {
  document: () => Promise<{ access?: string } | undefined>;
  list: () => Promise<Row[]>;
  onError: (error: unknown) => void;
};

const degraded = <Row>(): ViewerCommentLoad<Row> => ({ rows: [], canComment: false, deleteAny: false });

const decided = <Row>(rows: Row[], permissions: ArtifactPermissions): ViewerCommentLoad<Row> => ({
  rows,
  canComment: permissions.comment,
  deleteAny: permissions.deleteAny,
});

export async function loadViewerComments<Row>(source: ViewerCommentSource<Row>): Promise<ViewerCommentLoad<Row>> {
  try {
    const shared = await source.document();
    if (shared === undefined) return degraded<Row>();
    const permissions = artifactPermissions(shared.access);
    return decided(await source.list(), permissions);
  } catch (error) {
    source.onError(error);
    return degraded<Row>();
  }
}
