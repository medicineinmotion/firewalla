/*    Copyright 2016 Firewalla LLC 
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

'use strict';

const log = require('../../net2/logger.js')(__filename);
const fs = require('fs');
const cp = require('child_process');
const Promise = require('bluebird');
const util = require('util');
const f = require('../../net2/Firewalla.js');

const instances = {};

const VPNClient = require('./VPNClient.js');

const VPNClientEnforcer = require('./VPNClientEnforcer.js');
const vpnClientEnforcer = new VPNClientEnforcer();

const readFileAsync = util.promisify(fs.readFile);
const writeFileAsync = util.promisify(fs.writeFile);
const execAsync = util.promisify(cp.exec);

const SERVICE_NAME = "openvpn_client";

const routing = require('../routing/routing.js');

class OpenVPNClient extends VPNClient {
  constructor(options) {
    super(options);
    const profileId = options.profileId;
    if (!profileId)
      return null;
    if (instances[profileId] == null) {
      instances[profileId] = this;
      this.profileId = profileId;
    }
    return instances[profileId];
  }

  async setup() {
    const profileId = this.profileId;
    if (!profileId)
      throw "profileId is not set";
    const ovpnPath = this.getProfilePath();
    if (fs.existsSync(ovpnPath)) {
      this.ovpnPath = ovpnPath;
      await this._reviseProfile(this.ovpnPath);
    } else throw util.format("ovpn file %s is not found", ovpnPath);
    const passwordPath = this.getPasswordPath();
    if (!fs.existsSync(passwordPath)) {
      // create dummy password file, otherwise openvpn will report missing file on --askpass option
      await writeFileAsync(passwordPath, "dummy_ovpn_password", 'utf8');
    }
  }

  getProfilePath() {
    const path = f.getHiddenFolder() + "/run/ovpn_profile/" + this.profileId + ".ovpn";
    return path;
  }

  getPasswordPath() {
    const path = f.getHiddenFolder() + "/run/ovpn_profile/" + this.profileId + ".password";
    return path;
  }

  async _reviseProfile(ovpnPath) {
    const cmd = "openvpn --version | head -n 1 | awk '{print $2}'";
    const result = await execAsync(cmd);
    const version = result.stdout;
    let content = await readFileAsync(ovpnPath, 'utf8');
    let revisedContent = content;
    const intf = this.getInterfaceName();
    revisedContent = revisedContent.replace(/^dev\s+tun.*$/gm, `dev ${intf}`);
    if (version.startsWith("2.3.")) {
      const lines = content.split("\n");
      lines.forEach((line) => {
        const options = line.split(/\s+/);
        const option = options[0];
        switch (option) {
          case "compress":
            // OpenVPN 2.3.x does not support 'compress' option
            if (options.length > 1) {
              const algorithm = options[1];
              if (algorithm !== "lzo") {
                throw util.format("Unsupported compress algorithm for OpenVPN 2.3: %s", algorithm);
              } else {
                revisedContent = revisedContent.replace(/compress\s+lzo/g, "comp-lzo");
              }
            } else {
              // turn off compression, set 'comp-lzo' to no
              revisedContent = revisedContent.replace(/compress/g, "comp-lzo no");
            }
            break;
          default:
        }
      })
    }
    if (version.startsWith("2.4.")) {
      // 'comp-lzo' is deprecated in 2.4.x
      revisedContent = revisedContent.replace(/comp\-lzo/g, "compress lzo");
    }
    await writeFileAsync(ovpnPath, revisedContent, 'utf8');
  }

  async start() {
    if (!this.profileId) {
      throw "OpenVPN client is not setup properly. Profile id is missing."
    }
    let cmd = util.format("sudo systemctl start \"%s@%s\"", SERVICE_NAME, this.profileId);
    await execAsync(cmd);
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const establishmentTask = setInterval(() => {
        (async () => {
          const remoteIP = await this.getRemoteIP();
          if (remoteIP !== null && remoteIP !== "") {
            try {
              // remove two routes from main table which is inserted by OpenVPN client automatically,
              // otherwise tunnel will be enabled globally
              const intf = this.getInterfaceName();
              await routing.removeRouteFromTable("0.0.0.0/1", remoteIP, intf, "main");
              await routing.removeRouteFromTable("128.0.0.0/1", remoteIP, intf, "main");
            } catch (err) {
              // these routes may not exist depending on server config
              log.error("Failed to remove default vpn client route", err);
            }
            clearInterval(establishmentTask);
            const intf = this.getInterfaceName();
            const refreshRoutes = (async() => {
              const newRemoteIP = await this.getRemoteIP();
              const newIntf = this.getInterfaceName();
              // no need to refresh if remote ip and interface are not changed
              if (newRemoteIP !== remoteIP || newIntf !== intf) {
                log.info("Refresh vpn client routes for " + newRemoteIP + ", " + newIntf);
                await vpnClientEnforcer.enforceVPNClientRoutes(newRemoteIP, newIntf);
              }
            });
            // add vpn client specific routes
            await vpnClientEnforcer.enforceVPNClientRoutes(remoteIP, intf);
            this.vpnClientRoutesTask = setInterval(() => {
              refreshRoutes().catch((err) => {
                log.error("Failed to refresh route", err);
              });
            }, 300000); // refresh routes once every 5 minutes, in case of remote IP or interface name change due to auto reconnection
            resolve(true);
          } else {
            const now = Date.now();
            if (now - startTime > 20000) {
              log.error("Failed to establish tunnel for OpenVPN client, stop it...");
              clearInterval(establishmentTask);
              resolve(false);
            }
          }
        })().catch((err) => {
          log.error("Failed to start vpn client", err);
          clearInterval(establishmentTask);
          resolve(false);
        });
      }, 2000);
    });
  }

  async stop() {
    // flush routes before stop vpn client to ensure smooth switch of traffic routing
    const intf = this.getInterfaceName();
    await vpnClientEnforcer.flushVPNClientRoutes(intf);
    let cmd = util.format("sudo systemctl stop \"%s@%s\"", SERVICE_NAME, this.profileId);
    await execAsync(cmd);
    cmd = util.format("sudo systemctl disable \"%s@%s\"", SERVICE_NAME, this.profileId);
    await execAsync(cmd);
    if (this.vpnClientRoutesTask) {
      clearInterval(this.vpnClientRoutesTask);
      this.vpnClientRoutesTask = null;
    }
  }

  async status() {
    const cmd = util.format("systemctl is-active \"%s@%s\"", SERVICE_NAME, this.profileId);
    try {
      await execAsync(cmd);
      return true;
    } catch (err) {
      return false;
    }
  }

  async getRemoteIP() {
    const intf = this.getInterfaceName();
    const cmd = util.format("ifconfig | grep '^%s' -A 2 | grep 'P-t-P' | awk '{print $2,$3}'", intf);
    const result = await execAsync(cmd);
    const lines = result.stdout.split('\n');
    for (let i in lines) {
      const line = lines[i];
      if (line.length == 0)
        continue;
      const addrs = line.split(" ");
      const local = addrs[0].split(':')[1];
      const peer = addrs[1].split(':')[1];
      if (local.split('.')[3] !== "1") {
        // this is an address belonging to OpenVPN client
        return peer;
      }
    }
    return null;
  }

  getInterfaceName() {
    if (!this.profileId) {
      throw "profile id is not defined"
    }
    return `tun_${this.profileId}`
  }
}

module.exports = OpenVPNClient;