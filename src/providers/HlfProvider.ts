import * as vscode from 'vscode';
import { ShellCommand } from '../utilities/ShellCommand';
import { LogType, DockerComposeFiles, Settings } from '../utilities/Constants';
import { Logger } from '../utilities/Logger';
import { setTimeout } from "timers/promises";
import { Prerequisites } from '../utilities/Prerequisites';
import { TelemetryLogger } from '../utilities/TelemetryLogger';

export class HlfProvider {
    public static islocalNetworkStarted: boolean = false;

    public static async createNetwork(): Promise<boolean>{
        const logger: Logger = Logger.instance();

        try{
            if(!(await Prerequisites.checkDocker())){
                logger.showMessage(LogType.error, "Prerequisite- Docker is not installed or running. Please install and start Docker and try again");
                return false;
            }
            if(!(await Prerequisites.checkDockerCompose())){
                logger.showMessage(LogType.error, "Prerequisite- Docker-compose is not installed. Please install latest version of Docker-compose and try again");
                return false;
            }

            var startTime = process.hrtime();
            const telemetryLogger = TelemetryLogger.instance();
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Starting local Fabric network",
                cancellable: true
                }, async (progress) => {
                    //Create the network by invoking Docker compose
                    //It is Ok to invoke Docker compose on a running network also
                    //Create the CA node first
                    await ShellCommand.runDockerCompose(DockerComposeFiles.localCa, ["up", "--detach"]);
                    progress.report({ increment: 10 });

                    //Create the required certificates
                    await ShellCommand.execDockerComposeSh(DockerComposeFiles.localCa, "ca.org1.debugger.com", "/etc/hyperledger/fabric/scripts/registerEnrollOneOrg.sh");
                    progress.report({ increment: 20 });

                    //Create the rest of the nodes
                    await ShellCommand.runDockerCompose(DockerComposeFiles.localNetwork, ["up", "--detach"]);
                    logger.log(LogType.info, "Created local Fabric network");
                    progress.report({ increment: 70, message: "Creating channel" });

                    //Wait for some time for the nodes to be fully functional
                    await setTimeout(1000);
                    //Create the default channel
                    await ShellCommand.execDockerComposeBash(DockerComposeFiles.localNetwork, "debug-cli", "/etc/hyperledger/fabric/scripts/createChannelInternal.sh");
                    progress.report({ increment: 85, message: "Deploying chaincode" });

                    if(Settings.isCaas){
                        //Install chaincode on peers
                        await this.installCaasChaincode();
                    }
                    else{
                        Settings.defaultChaincodePackageId = `${Settings.defaultChaincodeId}:${Settings.defaultChaincodeVersion}`;
                    }

                    //Approve and Commit chaincode on the channel
                    let chaincodeArgs: string[] = [Settings.defaultChaincodeId, Settings.defaultChaincodeVersion, Settings.defaultChaincodePackageId];
                    await ShellCommand.execDockerComposeBash(DockerComposeFiles.localNetwork, "debug-cli", "/etc/hyperledger/fabric/scripts/deployChaincodeInternal.sh", chaincodeArgs);
                    progress.report({ increment: 100});

                    HlfProvider.islocalNetworkStarted = true;
                    vscode.commands.executeCommand('hlf.identity.refresh');
                    vscode.commands.executeCommand('hlf.localnetwork.refresh');
                    logger.showMessage(LogType.info, "Local Fabric Network started");
                });
                const elapsedTime = telemetryLogger.parseHrtimeToMs(process.hrtime(startTime));
                telemetryLogger.sendTelemetryEvent('CreateNetwork', null, {'createNetworkDuration': elapsedTime});
            return true;
        }
        catch(error){
            Logger.instance().showMessageOnly(LogType.error, `Failed to start local Fabric Network. ${error}`);
            return false;
        }
    }

    public static setChaincodeName(){
        if(vscode.workspace.name){
            //Chaincode name is the current workspace name. Replace all non-alphanumeric characters with "-".
            Settings.defaultChaincodeId = vscode.workspace.name.replace(/\W+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
            Settings.debugEnv.CORE_CHAINCODE_ID_NAME = `${Settings.defaultChaincodeId}:${Settings.defaultChaincodeVersion}`;
        }
    }

    public static async stopNetwork(): Promise<void>{
        //Stop existing debug session
        vscode.debug.stopDebugging(vscode.debug.activeDebugSession);

        var startTime = process.hrtime();
        const telemetryLogger = TelemetryLogger.instance();
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Stopping local Fabric network",
            cancellable: true
            }, async (progress) => {
                try{
                    progress.report({ increment: 20 });
                    //Stop the CA node
                    await ShellCommand.runDockerCompose(DockerComposeFiles.localCa, ["stop"]);
                    progress.report({ increment: 40});
                    //Stop the rest of the nodes
                    await ShellCommand.runDockerCompose(DockerComposeFiles.localNetwork, ["stop"]);
                    progress.report({ increment: 100});
                }
                catch (error){
                    if(error.indexOf('ENOENT')>-1){
                        Logger.instance().showMessage(LogType.error, `Prerequisite- Docker is not installed. Please install latest version of Docker and Docker-compose and try again`);
                    }
                    else{
                        Logger.instance().showMessageOnly(LogType.error, "Failed to stop local Fabric Network");
                    }
                }

                HlfProvider.islocalNetworkStarted = false;
                vscode.commands.executeCommand('hlf.identity.refresh');
                vscode.commands.executeCommand('hlf.localnetwork.refresh');
                Logger.instance().showMessage(LogType.info, "Local Fabric Network stopped");
            }
        );
        const elapsedTime = telemetryLogger.parseHrtimeToMs(process.hrtime(startTime));
        telemetryLogger.sendTelemetryEvent('StopNetwork', null, {'stopNetworkDuration': elapsedTime});
    }

    public static async restartNetwork(): Promise<void>{
        await this.stopNetwork();
        await this.createNetwork();

    }

    public static async removeNetwork(): Promise<void>{
        //Stop existing debug session
        vscode.debug.stopDebugging(vscode.debug.activeDebugSession);

        var startTime = process.hrtime();
        const telemetryLogger = TelemetryLogger.instance();
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Removing local Fabric network",
            cancellable: true
            }, async (progress) => {
                try{
                    //Cleanup the files related to the local network
                    await ShellCommand.execDockerComposeBash(DockerComposeFiles.localNetwork, "debug-cli", "/etc/hyperledger/fabric/scripts/cleanupFiles.sh");
                    progress.report({ increment: 20 });
                    //Remove all the nodes except CA
                    await ShellCommand.runDockerCompose(DockerComposeFiles.localNetwork, ["down", "-v"]);
                    progress.report({ increment: 80});
                    //Remove the CA node
                    await ShellCommand.runDockerCompose(DockerComposeFiles.localCa, ["down", "-v"]);
                    progress.report({ increment: 100});
                }
                catch (error){
                    if(error.indexOf('ENOENT')>-1){
                        Logger.instance().showMessage(LogType.error, `Prerequisite- Docker is not installed. Please install latest version of Docker and Docker-compose and try again`);
                    }
                    else{
                        Logger.instance().showMessageOnly(LogType.error, "Failed to remove local Fabric Network");
                    }
                }

                HlfProvider.islocalNetworkStarted = false;
                vscode.commands.executeCommand('hlf.identity.refresh');
                vscode.commands.executeCommand('hlf.localnetwork.refresh');
                Logger.instance().showMessage(LogType.info, "Local Fabric Network removed");
            }
        );
        const elapsedTime = telemetryLogger.parseHrtimeToMs(process.hrtime(startTime));
        telemetryLogger.sendTelemetryEvent('RemoveNetwork', null, {'removeNetworkDuration': elapsedTime});
    }

    public static async installCaasChaincode(): Promise<void>{
        let chaincodeArgs: string[] = [Settings.defaultChaincodeId];
        //Package the chaincode first
        Settings.defaultChaincodePackageId = (await ShellCommand.execDockerComposeBash(DockerComposeFiles.localNetwork, "debug-cli", "/etc/hyperledger/fabric/scripts/packageCaasChaincode.sh", chaincodeArgs)).replace("\n", "");
        Settings.debugCaasEnv.CHAINCODE_ID = Settings.defaultChaincodePackageId;
        //Install the chaincode on the peers
        await ShellCommand.execDockerComposeBash(DockerComposeFiles.localNetwork, "debug-cli", "/etc/hyperledger/fabric/scripts/installCaasChaincode.sh", chaincodeArgs);
    }

    public static async shouldRestart(debugConfiguration: vscode.DebugConfiguration): Promise<boolean> {
		let shouldRestart: boolean = false;

        //If external chaincode setting has changed, we should restart
		if(Settings.isCaas !== debugConfiguration.isCaas){
			shouldRestart = true;
		}

        //Check if all the docker containers are running. If not, we should try to restart
		const result = await ShellCommand.runDockerCompose(DockerComposeFiles.localNetwork, ["ls", "--filter", `name=${Settings.singleOrgProj}`], false);
        if(result.toLowerCase().indexOf("running(5)") === -1){
            shouldRestart = true;
        }
        
        return shouldRestart;
	}
}