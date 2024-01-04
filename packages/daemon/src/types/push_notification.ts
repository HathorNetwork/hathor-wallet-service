/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export interface SendNotificationToDevice {
  deviceId: string,
  /**
   * A string map used to send data in the notification message.
   * @see LocalizeMetadataNotification
   *
   * @example
   * {
   *    "titleLocKey": "new_transaction_received_title",
   *    "bodyLocKey": "new_transaction_received_description_with_tokens",
   *    "bodyLocArgs": "['13 HTR', '8 TNT', '2']"
   * }
   */
  metadata: Record<string, string>,
}
