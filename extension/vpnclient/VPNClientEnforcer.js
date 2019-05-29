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
const cp = require('child_process');
const ipTool = require('ip');
const util = require('util');
const routing = require('../routing/routing.js');
const HostTool = require('../../net2/HostTool.js');
const hostTool = new HostTool();


const SysManager = require('../../net2/SysManager.js');

const execAsync = util.promisify(cp.exec);
var instance = null;

const VPN_CLIENT_RULE_TABLE = "vpn_client";

class VPNClientEnforcer {
  constructor() {
    if (instance == null) {
      instance = this;
    }
    this.enabledHosts = {};
    if (process.title === "FireMain") {
      setInterval(() => {
        try {
          log.info("Check and refresh routing rule for VPN client...");
          this._periodicalRefreshRule();
        } catch (err) {
          log.error("Failed to refresh routing rule for VPN client: ", err);
        }
      }, 300 * 1000); // once every 5 minutes
    }
    return instance;
  }

  _getRoutingTableName(intf) {
    return `${VPN_CLIENT_RULE_TABLE}_${intf}`;
  }

  async enableVPNAccess(mac, mode, intf) {
    if (!intf)
      throw "interface is not defined";
    const tableName = this._getRoutingTableName(intf);
    // ensure customized routing table is created
    await routing.createCustomizedRoutingTable(tableName);
    const host = await hostTool.getMACEntry(mac);
    host.vpnClientMode = mode;
    host.vpnClientIntf = intf;
    this.enabledHosts[mac] = host;
    switch (mode) {
      case "dhcp":
        const mode = require('../../net2/Mode.js');
        await mode.reloadSetupMode();
        // enforcement takes effect if devcie ip address is in overlay network or dhcp spoof mode is on
        if (this._isSecondaryInterfaceIP(host.ipv4Addr) || await mode.isDHCPSpoofModeOn()) {
          try {
            await routing.removePolicyRoutingRule(host.ipv4Addr);
          } catch (err) {
            log.error("Failed to remove policy routing rule for " + host.ipv4Addr, err);
          }
          if (host.spoofing === "true") {
            log.info("Add vpn client routing rule for " + host.ipv4Addr);
            await routing.createPolicyRoutingRule(host.ipv4Addr, tableName);
          }
        } else {
          log.warn(util.format("IP address %s is not assigned by secondary interface, vpn access of %s is suspended.", host.ipv4Addr, mac));
        }
        break;
      default:
        log.error("Unsupported vpn client mode: " + mode);
    }  
  }

  async disableVPNAccess(mac) {
    if (this.enabledHosts[mac]) {
      const host = this.enabledHosts[mac];
      const intf = host.vpnClientIntf;
      const tableName = this._getRoutingTableName(intf);
      try {
        await routing.removePolicyRoutingRule(host.ipv4Addr, tableName);
      } catch (err) {
        log.error("Failed to remove policy routing rule for " + host.ipv4Addr, err);
      }
      delete this.enabledHosts[mac];
    }
  }

  async enforceVPNClientRoutes(remoteIP, intf) {
    if (!intf)
      throw "Interface is not specified";
    const tableName = this._getRoutingTableName(intf);
    // ensure customized routing table is created
    await routing.createCustomizedRoutingTable(tableName);
    // add routes from main routing table to vpn client table except default route
    await routing.flushRoutingTable(tableName);
    let cmd = "ip route list | grep -v default";
    const routes = await execAsync(cmd);
    await Promise.all(routes.stdout.split('\n').map(async route => {
      if (route.length > 0) {
        cmd = util.format("sudo ip route add %s table %s", route, tableName);
        await execAsync(cmd);
      }
    }));
    // then add remote IP as gateway of default route to vpn client table
    await routing.addRouteToTable("default", remoteIP, intf, tableName);
  }

  async flushVPNClientRoutes(intf) {
    if (!intf)
      throw "Interface is not specified";
    const tableName = this._getRoutingTableName(intf);
    await routing.createCustomizedRoutingTable(tableName);
    await routing.flushRoutingTable(tableName);
  }

  async _periodicalRefreshRule() {
    await Promise.all(Object.keys(this.enabledHosts).map(async mac => {
      const host = await hostTool.getMACEntry(mac);
      const oldHost = this.enabledHosts[mac];
      const enabledMode = oldHost.vpnClientMode;
      host.vpnClientMode = enabledMode;
      host.vpnClientIntf = oldHost.vpnClientIntf;
      const tableName = this._getRoutingTableName(host.vpnClientIntf);
      switch (enabledMode) {
        case "dhcp":
          const mode = require('../../net2/Mode.js');
          await mode.reloadSetupMode();
          if (host.ipv4Addr !== oldHost.ipv4Addr || (!this._isSecondaryInterfaceIP(host.ipv4Addr) && !(await mode.isDHCPSpoofModeOn())) || host.spoofing === "false") {
            // policy routing rule should be removed anyway if ip address is changed or ip address is not assigned by secondary interface
            // or host is not monitored
            try {
              await routing.removePolicyRoutingRule(oldHost.ipv4Addr, tableName);
            } catch (err) {
              log.error("Failed to remove policy routing rule for " + host.ipv4Addr, err);
            }
          }
          if ((this._isSecondaryInterfaceIP(host.ipv4Addr) || await mode.isDHCPSpoofModeOn()) && host.spoofing === "true") {
            await routing.createPolicyRoutingRule(host.ipv4Addr, tableName);
          }
          this.enabledHosts[mac] = host;
          break;
        default:
          log.error("Unsupported vpn client mode: " + enabledMode);
      }
    }));
  }

  _isSecondaryInterfaceIP(ip) {
    const sysManager = new SysManager();
    const ip2 = sysManager.myIp2();
    const ipMask2 = sysManager.myIpMask2();
    
    if(ip && ip2 && ipMask2) {
      return ipTool.subnet(ip2, ipMask2).contains(ip);
    }
    return false;
  }
}

module.exports = VPNClientEnforcer;