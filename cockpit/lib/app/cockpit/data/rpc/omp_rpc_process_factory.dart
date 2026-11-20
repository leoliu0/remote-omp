import 'package:cockpit/app/core/env.dart';
import 'package:cockpit/app/cockpit/data/rpc/omp_rpc_process.dart';
import 'package:cockpit/app/cockpit/domain/contracts/rpc_gateway_factory.dart';
import 'package:cockpit/app/cockpit/domain/contracts/rpc_process_gateway.dart';

/// Cria um [OmpRpcProcess] novo por agente (multiplexação da Wave 2).
class OmpRpcProcessFactory implements RpcGatewayFactory {
  const OmpRpcProcessFactory(this._config);

  final OmpSpawnConfig _config;

  @override
  RpcProcessGateway create() => OmpRpcProcess(_config);
}
