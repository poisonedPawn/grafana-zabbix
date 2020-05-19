import _ from 'lodash';
import semver from 'semver';
import kbn from 'grafana/app/core/utils/kbn';
import * as utils from '../../../utils';
import { ZabbixAPICore } from './zabbixAPICore';
import { ZBX_ACK_ACTION_NONE, ZBX_ACK_ACTION_ACK, ZBX_ACK_ACTION_ADD_MESSAGE, MIN_SLA_INTERVAL } from '../../../constants';
import { ShowProblemTypes, ZBXProblem } from '../../../types';
import { JSONRPCRequestParams } from './types';

const DEFAULT_ZABBIX_VERSION = '3.0.0';

/**
 * Zabbix API Wrapper.
 * Creates Zabbix API instance with given parameters (url, credentials and other).
 * Wraps API calls and provides high-level methods.
 */
export class ZabbixAPIConnector {
  url: string;
  username: string;
  password: string;
  auth: string;
  requestOptions: { basicAuth: any; withCredentials: boolean; };
  loginPromise: Promise<string>;
  loginErrorCount: number;
  maxLoginAttempts: number;
  zabbixAPICore: ZabbixAPICore;
  getTrend: (items: any, timeFrom: any, timeTill: any) => Promise<any[]>;
  version: string;
  getVersionPromise: Promise<string>;

  constructor(api_url: string, username: string, password: string, basicAuth: any, withCredentials: boolean) {
    this.url              = api_url;
    this.username         = username;
    this.password         = password;
    this.auth             = '';

    this.requestOptions = {
      basicAuth: basicAuth,
      withCredentials: withCredentials
    };

    this.loginPromise = null;
    this.loginErrorCount = 0;
    this.maxLoginAttempts = 3;

    this.zabbixAPICore = new ZabbixAPICore();

    this.getTrend = this.getTrend_ZBXNEXT1193;
    //getTrend = getTrend_30;

    this.initVersion();
  }

  //////////////////////////
  // Core method wrappers //
  //////////////////////////

  request(method: string, params: JSONRPCRequestParams): Promise<any> {
    if (!this.version) {
      return this.initVersion().then(() => this.request(method, params));
    }

    return this.zabbixAPICore.request(this.url, method, params, this.requestOptions, this.auth)
    .catch(error => {
      if (isNotAuthorized(error.data)) {
        // Handle auth errors
        this.loginErrorCount++;
        if (this.loginErrorCount > this.maxLoginAttempts) {
          this.loginErrorCount = 0;
          return null;
        } else {
          return this.loginOnce()
          .then(() => this.request(method, params));
        }
      } else {
        return Promise.reject(error);
      }
    });
  }

  /**
   * When API unauthenticated or auth token expired each request produce login()
   * call. But auth token is common to all requests. This function wraps login() method
   * and call it once. If login() already called just wait for it (return its promise).
   */
  loginOnce(): Promise<string> {
    if (!this.loginPromise) {
      this.loginPromise = Promise.resolve(
        this.login().then(auth => {
          this.auth = auth;
          this.loginPromise = null;
          return auth;
        })
      );
    }
    return this.loginPromise;
  }

  /**
   * Get authentication token.
   */
  login(): Promise<string> {
    return this.zabbixAPICore.login(this.url, this.username, this.password, this.requestOptions);
  }

  /**
   * Get Zabbix API version
   */
  getVersion() {
    return this.zabbixAPICore.getVersion(this.url, this.requestOptions);
  }

  initVersion(): Promise<string> {
    if (!this.getVersionPromise) {
      this.getVersionPromise = Promise.resolve(
        this.getVersion().then(version => {
          if (version) {
            console.log(`Zabbix version detected: ${version}`);
          } else {
            console.log(`Failed to detect Zabbix version, use default ${DEFAULT_ZABBIX_VERSION}`);
          }

          this.version = version || DEFAULT_ZABBIX_VERSION;
          this.getVersionPromise = null;
          return version;
        })
      );
    }
    return this.getVersionPromise;
  }

  ////////////////////////////////
  // Zabbix API method wrappers //
  ////////////////////////////////

  acknowledgeEvent(eventid: string, message: string, action?: number, severity?: number) {
    if (!action) {
      action = semver.gte(this.version, '4.0.0') ? ZBX_ACK_ACTION_ADD_MESSAGE : ZBX_ACK_ACTION_NONE;
    }

    const params: any = {
      eventids: eventid,
      message: message,
      action: action
    };

    if (severity) {
      params.severity = severity;
    }

    return this.request('event.acknowledge', params);
  }

  getGroups() {
    const params = {
      output: ['name'],
      sortfield: 'name',
      real_hosts: true
    };

    return this.request('hostgroup.get', params);
  }

  getHosts(groupids) {
    const params: any = {
      output: ['name', 'host'],
      sortfield: 'name'
    };
    if (groupids) {
      params.groupids = groupids;
    }

    return this.request('host.get', params);
  }

  getApps(hostids): Promise<any[]> {
    const params = {
      output: 'extend',
      hostids: hostids
    };

    return this.request('application.get', params);
  }

  /**
   * Get Zabbix items
   * @param  {[type]} hostids  host ids
   * @param  {[type]} appids   application ids
   * @param  {String} itemtype 'num' or 'text'
   * @return {[type]}          array of items
   */
  getItems(hostids, appids, itemtype) {
    const params: any = {
      output: [
        'name', 'key_',
        'value_type',
        'hostid',
        'status',
        'state'
      ],
      sortfield: 'name',
      webitems: true,
      filter: {},
      selectHosts: ['hostid', 'name', 'host']
    };
    if (hostids) {
      params.hostids = hostids;
    }
    if (appids) {
      params.applicationids = appids;
    }
    if (itemtype === 'num') {
      // Return only numeric metrics
      params.filter.value_type = [0, 3];
    }
    if (itemtype === 'text') {
      // Return only text metrics
      params.filter.value_type = [1, 2, 4];
    }

    return this.request('item.get', params)
    .then(utils.expandItems);
  }

  getItemsByIDs(itemids) {
    const params = {
      itemids: itemids,
      output: [
        'name', 'key_',
        'value_type',
        'hostid',
        'status',
        'state'
      ],
      webitems: true,
      selectHosts: ['hostid', 'name']
    };

    return this.request('item.get', params)
    .then(utils.expandItems);
  }

  getMacros(hostids) {
    const params = {
      output: 'extend',
      hostids: hostids
    };

    return this.request('usermacro.get', params);
  }

  getGlobalMacros() {
    const params = {
      output: 'extend',
      globalmacro: true
    };

    return this.request('usermacro.get', params);
  }

  getLastValue(itemid) {
    const params = {
      output: ['lastvalue'],
      itemids: itemid
    };
    return this.request('item.get', params)
    .then(items => items.length ? items[0].lastvalue : null);
  }

  /**
   * Perform history query from Zabbix API
   *
   * @param  {Array}  items       Array of Zabbix item objects
   * @param  {Number} timeFrom   Time in seconds
   * @param  {Number} timeTill   Time in seconds
   * @return {Array}  Array of Zabbix history objects
   */
  getHistory(items, timeFrom, timeTill) {

    // Group items by value type and perform request for each value type
    const grouped_items = _.groupBy(items, 'value_type');
    const promises = _.map(grouped_items, (items, value_type) => {
      const itemids = _.map(items, 'itemid');
      const params: any = {
        output: 'extend',
        history: value_type,
        itemids: itemids,
        sortfield: 'clock',
        sortorder: 'ASC',
        time_from: timeFrom
      };

      // Relative queries (e.g. last hour) don't include an end time
      if (timeTill) {
        params.time_till = timeTill;
      }

      return this.request('history.get', params);
    });

    return Promise.all(promises).then(_.flatten);
  }

  /**
   * Perform trends query from Zabbix API
   * Use trends api extension from ZBXNEXT-1193 patch.
   *
   * @param  {Array}  items       Array of Zabbix item objects
   * @param  {Number} time_from   Time in seconds
   * @param  {Number} time_till   Time in seconds
   * @return {Array}  Array of Zabbix trend objects
   */
  getTrend_ZBXNEXT1193(items, timeFrom, timeTill) {

    // Group items by value type and perform request for each value type
    const grouped_items = _.groupBy(items, 'value_type');
    const promises = _.map(grouped_items, (items, value_type) => {
      const itemids = _.map(items, 'itemid');
      const params: any = {
        output: 'extend',
        trend: value_type,
        itemids: itemids,
        sortfield: 'clock',
        sortorder: 'ASC',
        time_from: timeFrom
      };

      // Relative queries (e.g. last hour) don't include an end time
      if (timeTill) {
        params.time_till = timeTill;
      }

      return this.request('trend.get', params);
    });

    return Promise.all(promises).then(_.flatten);
  }

  getTrend_30(items, time_from, time_till, value_type) {
    const self = this;
    const itemids = _.map(items, 'itemid');

    const params: any = {
      output: ["itemid",
        "clock",
        value_type
      ],
      itemids: itemids,
      time_from: time_from
    };

    // Relative queries (e.g. last hour) don't include an end time
    if (time_till) {
      params.time_till = time_till;
    }

    return self.request('trend.get', params);
  }

  getITService(serviceids?) {
    const params = {
      output: 'extend',
      serviceids: serviceids
    };
    return this.request('service.get', params);
  }

  getSLA(serviceids, timeRange, options) {
    const intervals = buildSLAIntervals(timeRange, options.intervalMs);
    const params = {
      serviceids,
      intervals
    };
    return this.request('service.getsla', params);
  }

  getProblems(groupids, hostids, applicationids, options): Promise<ZBXProblem[]> {
    const { timeFrom, timeTo, recent, severities, limit } = options;

    const params: any = {
      output: 'extend',
      selectAcknowledges: 'extend',
      selectSuppressionData: 'extend',
      selectTags: 'extend',
      source: '0',
      object: '0',
      sortfield: ['eventid'],
      sortorder: 'ASC',
      evaltype: '0',
      // preservekeys: '1',
      groupids,
      hostids,
      applicationids,
      recent,
    };

    if (severities) {
      params.severities = severities;
    }

    if (limit) {
      params.limit = limit;
    }

    if (timeFrom || timeTo) {
      params.time_from = timeFrom;
      params.time_till = timeTo;
    }

    return this.request('problem.get', params);
  }

  getTriggersByIds(triggerids: string[]) {
    const params: any = {
      output: 'extend',
      triggerids: triggerids,
      expandDescription: true,
      expandData: true,
      expandComment: true,
      monitored: true,
      skipDependent: true,
      selectGroups: ['name'],
      selectHosts: ['name', 'host', 'maintenance_status', 'proxy_hostid'],
      selectItems: ['name', 'key_', 'lastvalue'],
      // selectLastEvent: 'extend',
      // selectTags: 'extend',
      preservekeys: '1',
    };

    return this.request('trigger.get', params);
  }

  getTriggers(groupids, hostids, applicationids, options) {
    const {showTriggers, maintenance, timeFrom, timeTo} = options;

    const params: any = {
      output: 'extend',
      groupids: groupids,
      hostids: hostids,
      applicationids: applicationids,
      expandDescription: true,
      expandData: true,
      expandComment: true,
      monitored: true,
      skipDependent: true,
      //only_true: true,
      filter: {
        value: 1
      },
      selectGroups: ['name'],
      selectHosts: ['name', 'host', 'maintenance_status', 'proxy_hostid'],
      selectItems: ['name', 'key_', 'lastvalue'],
      selectLastEvent: 'extend',
      selectTags: 'extend'
    };

    if (showTriggers === ShowProblemTypes.Problems) {
      params.filter.value = 1;
    } else if (showTriggers === ShowProblemTypes.Recent || showTriggers === ShowProblemTypes.History) {
      params.filter.value = [0, 1];
    }

    if (maintenance) {
      params.maintenance = true;
    }

    if (timeFrom || timeTo) {
      params.lastChangeSince = timeFrom;
      params.lastChangeTill = timeTo;
    }

    return this.request('trigger.get', params);
  }

  getEvents(objectids, timeFrom, timeTo, showEvents, limit) {
    const params: any = {
      output: 'extend',
      time_from: timeFrom,
      time_till: timeTo,
      objectids: objectids,
      select_acknowledges: 'extend',
      selectHosts: 'extend',
      value: showEvents,
    };

    if (limit) {
      params.limit = limit;
      params.sortfield = 'clock';
      params.sortorder = 'DESC';
    }

    return this.request('event.get', params);
  }

  getEventsHistory(groupids, hostids, applicationids, options) {
    const { timeFrom, timeTo, severities, limit } = options;

    const params: any = {
      output: 'extend',
      time_from: timeFrom,
      time_till: timeTo,
      value: '1',
      source: '0',
      object: '0',
      evaltype: '0',
      sortfield: ['eventid'],
      sortorder: 'ASC',
      selectSuppressionData: ['maintenanceid', 'suppress_until'],
      groupids,
      hostids,
      applicationids,
    };

    if (limit) {
      params.limit = limit;
    }

    if (severities) {
      params.severities = severities;
    }

    return this.request('event.get', params);
  }

  getExtendedEventData(eventids) {
    const params = {
      output: 'extend',
      eventids: eventids,
      preservekeys: true,
      select_acknowledges: 'extend',
      selectTags: 'extend',
      sortfield: 'clock',
      sortorder: 'DESC'
    };

    return this.request('event.get', params);
  }

  getEventAlerts(eventids) {
    const params = {
      eventids: eventids,
      output: [
        'eventid',
        'message',
        'clock',
        'error'
      ],
      selectUsers: true,
    };

    return this.request('alert.get', params);
  }

  getAcknowledges(eventids) {
    const params = {
      output: 'extend',
      eventids: eventids,
      preservekeys: true,
      select_acknowledges: 'extend',
      sortfield: 'clock',
      sortorder: 'DESC'
    };

    return this.request('event.get', params)
    .then(events => {
      return _.filter(events, (event) => event.acknowledges.length);
    });
  }

  getAlerts(itemids, timeFrom, timeTo) {
    const params: any = {
      output: 'extend',
      itemids: itemids,
      expandDescription: true,
      expandData: true,
      expandComment: true,
      monitored: true,
      skipDependent: true,
      //only_true: true,
      // filter: {
      //   value: 1
      // },
      selectLastEvent: 'extend'
    };

    if (timeFrom || timeTo) {
      params.lastChangeSince = timeFrom;
      params.lastChangeTill = timeTo;
    }

    return this.request('trigger.get', params);
  }

  getHostAlerts(hostids, applicationids, options) {
    const {minSeverity, acknowledged, count, timeFrom, timeTo} = options;
    const params: any = {
      output: 'extend',
      hostids: hostids,
      min_severity: minSeverity,
      filter: { value: 1 },
      expandDescription: true,
      expandData: true,
      expandComment: true,
      monitored: true,
      skipDependent: true,
      selectLastEvent: 'extend',
      selectGroups: 'extend',
      selectHosts: ['host', 'name']
    };

    if (count && acknowledged !== 0 && acknowledged !== 1) {
      params.countOutput = true;
    }

    if (applicationids && applicationids.length) {
      params.applicationids = applicationids;
    }

    if (timeFrom || timeTo) {
      params.lastChangeSince = timeFrom;
      params.lastChangeTill = timeTo;
    }

    return this.request('trigger.get', params)
    .then((triggers) => {
      if (!count || acknowledged === 0 || acknowledged === 1) {
        triggers = filterTriggersByAcknowledge(triggers, acknowledged);
        if (count) {
          triggers = triggers.length;
        }
      }
      return triggers;
    });
  }

  getProxies() {
    const params = {
      output: ['proxyid', 'host'],
    };

    return this.request('proxy.get', params);
  }
}

function filterTriggersByAcknowledge(triggers, acknowledged) {
  if (acknowledged === 0) {
    return _.filter(triggers, (trigger) => trigger.lastEvent.acknowledged === "0");
  } else if (acknowledged === 1) {
    return _.filter(triggers, (trigger) => trigger.lastEvent.acknowledged === "1");
  } else {
    return triggers;
  }
}

function isNotAuthorized(message) {
  return (
    message === "Session terminated, re-login, please." ||
    message === "Not authorised." ||
    message === "Not authorized."
  );
}

function getSLAInterval(intervalMs) {
  // Too many intervals may cause significant load on the database, so decrease number of resulting points
  const resolutionRatio = 100;
  const interval = kbn.round_interval(intervalMs * resolutionRatio) / 1000;
  return Math.max(interval, MIN_SLA_INTERVAL);
}

function buildSLAIntervals(timeRange, intervalMs) {
  let [timeFrom, timeTo] = timeRange;
  const slaInterval = getSLAInterval(intervalMs);
  const intervals = [];

  // Align time range with calculated interval
  timeFrom = Math.floor(timeFrom / slaInterval) * slaInterval;
  timeTo = Math.ceil(timeTo / slaInterval) * slaInterval;

  for (let i = timeFrom; i <= timeTo - slaInterval; i += slaInterval) {
    intervals.push({
      from : i,
      to : (i + slaInterval)
    });

  }

  return intervals;
}