/**
 * Point d'entrée du sous-système « protocoles non-HTTP ».
 * Compartimenté : le cœur HTTP du SDK n'importe rien d'ici.
 */
export * from "./types.js";
export { parseProtocolCommand } from "./parse.js";
export type { ProtocolParseOptions, ProtocolParseResult } from "./parse.js";
export {
  registerProtocol,
  unregisterProtocol,
  getProtocolAdapter,
  registeredSchemes,
  executeProtocol,
} from "./registry.js";

export { fileAdapter } from "./file.js";
export { smtpAdapter } from "./smtp.js";
export { ftpAdapter } from "./ftp.js";
export { sftpAdapter } from "./sftp.js";
export { pop3Adapter } from "./pop3.js";
export { mqttAdapter } from "./mqtt.js";
export { tftpAdapter } from "./tftp.js";
export { smbAdapter } from "./smb.js";

export type { MailTransport, MailTransportFactory } from "./smtp.js";
export type { FtpClient, FtpClientFactory } from "./ftp.js";
export type { SftpClient, SftpClientFactory } from "./sftp.js";
export type { Pop3Client, Pop3ClientFactory } from "./pop3.js";
export type { MqttClient, MqttClientFactory } from "./mqtt.js";
export type { TftpClient, TftpClientFactory } from "./tftp.js";
export type { SmbClient, SmbClientFactory } from "./smb.js";

import { registerProtocol } from "./registry.js";
import { fileAdapter } from "./file.js";
import { smtpAdapter } from "./smtp.js";
import { ftpAdapter } from "./ftp.js";
import { sftpAdapter } from "./sftp.js";
import { pop3Adapter } from "./pop3.js";
import { mqttAdapter } from "./mqtt.js";
import { tftpAdapter } from "./tftp.js";
import { smbAdapter } from "./smb.js";

/**
 * Enregistre tous les adaptateurs de référence.
 * À appeler une fois côté Node avant d'exécuter des commandes non-HTTP.
 * Les bibliothèques sous-jacentes (nodemailer, basic-ftp, ssh2, mqtt,
 * @marsaud/smb2) ne sont chargées qu'au premier usage effectif du protocole.
 */
export function registerDefaultNodeAdapters(): void {
  for (const adapter of [fileAdapter, smtpAdapter, ftpAdapter, sftpAdapter, pop3Adapter, mqttAdapter, tftpAdapter, smbAdapter]) {
    registerProtocol(adapter);
  }
}
