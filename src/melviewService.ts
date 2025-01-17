import {API, Logger, PlatformConfig} from 'homebridge';
import fetch, {Response} from 'node-fetch';
import {Cookie} from 'tough-cookie';
import {Account, Building, Capabilities, CommandResponse, State} from './data';
import {Command} from './melviewCommand';

const URL = 'https://api.melview.net/api/';
const APP_VERSION = '5.3.1348';
const AUTH_SERVICE = 'login.aspx';
const ROOMS_SERVICE = 'rooms.aspx';
const COMMAND_SERVICE = 'unitcommand.aspx';
const CAPABILITIES_SERVICE = 'unitcapabilities.aspx';

export class MelviewService {
    private auth?: Cookie;

    constructor(
        public readonly log: Logger,
        public readonly config: PlatformConfig,
        public readonly api: API,
    ) {
      this.log.debug('Test Service Instantiated!');
    }

    /**
     * Login to Melview API system.
     */
    public async login(): Promise<Account> {
      const response = await fetch(URL + AUTH_SERVICE, {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64; rv:54.0) Gecko/20100101 Firefox/54.0',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: JSON.stringify({
          user: this.config.user,
          pass: this.config.password,
          appversion: APP_VERSION,
        }),
      });

      if (!response || response.status !== 200) {
        throw new Error ('Failed to login - check the network.');
      }

      try {
        this.extractCookie(response);
      } catch (e) {
        this.log.debug(e);
        throw new Error ('Failed parse response from Melview - check the network.');
      }
      if (!this.auth) {
        throw new Error('Unable to get auth token from MelView - will retry.');
      }

      const body = await response.text();
      return JSON.parse(body) as Account;
    }

    /**
     * Queries the entire inventory of accessories listed in Melview for the account.
     */
    public async discover(): Promise<Building[] | undefined> {
      if (!this.auth) {
        return;
      }

      if (this.authWillExpire()) {
        this.login().catch(e => {
          this.log.error(e);
          return;
        });
      }

      const response = await fetch(URL + ROOMS_SERVICE, {
        method: 'POST',
        headers: this.populateHeaders(),
      });
      const body = await response.text();
      const buildings = JSON.parse(body) as Building[];
      return buildings;
    }

    /**
     * Query the capabilities of a given device.
     * @param unitID is the unit identifier
     */
    public async capabilities(unitID: string): Promise<Capabilities> {
      if (this.authWillExpire()) {
        this.login().catch(e => {
          this.log.error(e);
          return;
        });
      }

      const response = await fetch(URL + CAPABILITIES_SERVICE, {
        method: 'POST',
        headers: this.populateHeaders(),
        body: JSON.stringify({
          unitid: unitID,
        }),
      });
      const body = await response.text();
      return JSON.parse(body) as Capabilities;
    }


    /**
     * Issue a command to the melview platform.
     * @param unitID is the unit identifier
     * @param command is the command to be executed.
     * @param commandChain any additional commands to be executed in chain.
     */
    public async command(command : Command, ...commandChain: Command[]) {
      const allComms = [command, ...commandChain].map(c => c.execute()).join(',');
      if (this.authWillExpire()) {
        this.login().catch(e => {
          this.log.error(e);
          return;
        });
      }

      const req = JSON.stringify({
        unitid: command.getUnitID(),
        v: 2,
        commands: allComms,
        lc: 1,
      });
      this.log.debug('cmd:', req);
      const response = await fetch(URL + COMMAND_SERVICE, {
        method: 'POST',
        headers: this.populateHeaders(),
        body: req,
      });
      this.log.debug(req);
      const body = await response.text();
      const rBody = JSON.parse(body) as CommandResponse;
      if (rBody.error === 'ok' && rBody.lc && rBody.lc.length > 0) {
        const xmlBody = command.getLocalCommandBody(rBody.lc);
        fetch(command.getLocalCommandURL(), {
          method: 'POST',
          body: xmlBody,
        }).then(r =>{
          r.text().then(v => {
            this.log.debug('Successfully processed local request:', v);
          }).finally();
        }).catch(e => {
          this.log.warn('Unable to access unit via direct LAN interface.', e);
        }).finally();
      }
    }

    /**
     * Get the current state of the unit.
     * @param unitID is the unit identifier
     */
    public async getStatus(unitID: string): Promise<State> {
      if (this.authWillExpire()) {
        this.login().catch(e => {
          this.log.error(e);
          return;
        });
      }

      const response = await fetch(URL + COMMAND_SERVICE, {
        method: 'POST',
        headers: this.populateHeaders(),
        body: JSON.stringify({
          unitid: unitID,
        }),
      });
      const body = await response.text();
      return JSON.parse(body) as State;
    }

    private extractCookie(response: Response) {
      const raw = JSON.stringify(response.headers.raw()['set-cookie']);
      this.auth = Cookie.parse(raw) as Cookie;
    }

    // private async debugResponse(method: string, response: Response): Promise<string> {
    //   // this.log.debug(method, 'HEADERS:--------------------------------------\n',
    //   //   JSON.stringify(response.headers.raw()));
    //   const body = await response.text();
    //   // this.log.debug(method, 'BODY:--------------------------------------\n',
    //   //   body);
    //   return body;
    // }

    private populateHeaders() {
      return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64; rv:54.0) Gecko/20100101 Firefox/54.0',
        'Content-Type': 'application/json',
        'cookie': 'auth=' + this.auth!.value,
      };
    }

    public authWillExpire(): boolean {
      if (this.auth) {
        try {
          const time = this.auth!.expiryTime(Date.now());
          return (time / (1000 * 60 * 60)) <= 0.0;
        } catch (e) {
          this.log.error(e);
          return true;
        }
      }
      return true;
    }
}
