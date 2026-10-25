import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const projectRoot=path.resolve(fileURLToPath(new URL('../../',import.meta.url)));
export const browserSources={
  "app.js": "src/app/app.js",
  "cloud-bootstrap.js": "src/app/cloud-bootstrap.js",
  "platform-app.js": "src/app/platform-app.js",
  "cloud-client.js": "src/app/cloud-client.js",
  "accounts-ui.js": "src/features/accounts/accounts-ui.js",
  "business-ui.js": "src/features/catalogue/business-ui.js",
  "pricing-ui.js": "src/features/catalogue/pricing-ui.js",
  "store-ui.js": "src/features/stores/store-ui.js",
  "overview-ui.js": "src/features/overview/overview-ui.js",
  "tasks-ui.js": "src/features/tasks/tasks-ui.js",
  "settlement-ui.js": "src/features/settlement/settlement-ui.js",
  "order-pdf.js": "src/features/settlement/order-pdf.js",
  "flow-ui.js": "src/features/flow/flow-ui.js",
  "flow-attachment-reader.js": "src/features/flow/flow-attachment-reader.js",
  "notifications-ui.js": "src/features/notifications/notifications-ui.js",
  "local-notifications.js": "src/features/notifications/local-notifications.js",
  "avatar-editor.js": "src/ui/avatar-editor.js",
  "directory-card.js": "src/ui/directory-card.js",
  "ui-controls.js": "src/ui/ui-controls.js",
  "ui-motion.js": "src/ui/ui-motion.js",
  "portal-icon.js": "src/ui/portal-icon.js",
  "sidebar-brand.js": "src/ui/sidebar-brand.js",
  "data.js": "src/shared/data.js",
  "business-data.js": "src/shared/business-data.js",
  "cloud-seed.js": "src/shared/cloud-seed.js",
  "notification-domain.js": "src/shared/notification-domain.js",
  "overview-data.js": "src/shared/overview-data.js",
  "settlement-data.js": "src/shared/settlement-data.js",
  "flow-attachment-data.js": "src/shared/flow-attachment-data.js",
  "japan-addresses.js": "src/shared/japan-addresses.js"
};
export const styleSources={
  "pricing-ui.css": "src/styles/pricing-ui.css",
  "settlement.css": "src/styles/settlement.css",
  "sidebar-brand.css": "src/styles/sidebar-brand.css",
  "overview.css": "src/styles/overview.css",
  "catalogue-units.css": "src/styles/catalogue-units.css",
  "flow-ui.css": "src/styles/flow-ui.css",
  "readability.css": "src/styles/readability.css",
  "styles.css": "src/styles/styles.css",
  "visual-refresh.css": "src/styles/visual-refresh.css",
  "portal-theme.css": "src/styles/portal-theme.css",
  "identity-layout.css": "src/styles/identity-layout.css",
  "store-ui.css": "src/styles/store-ui.css",
  "accounts.css": "src/styles/accounts.css",
  "order-ui.css": "src/styles/order-ui.css",
  "cloud.css": "src/styles/cloud.css",
  "ui-controls.css": "src/styles/ui-controls.css",
  "notifications.css": "src/styles/notifications.css",
  "ui-system.css": "src/styles/ui-system.css"
};
export const iconSources={
  "favicon.svg": "public/icons/favicon.svg",
  "flow-mark.svg": "public/icons/flow-mark.svg"
};
export const privateSeed='private-preview/data/business-data.js';
