const opcua = require("node-opcua");
const ModbusRTU = require("modbus-serial");
const express = require("express");
const path = require("path");
const { SerialPort } = require('serialport');

// Конфигурация
const OPC_UA_PORT = 52000;
const WEB_PORT = 3000;
const MODBUS_IP = "10.29.101.200";
const MODBUS_PORT = 502;
const DEVICE_ID = 1;
const TAG_ADDRESS = 97;

// Новая конфигурация для Modbus RTU
const COM_PORT = "COM7"; // или "/dev/ttyUSB0" для Linux
const BAUD_RATE = 9600;
const RTU_DEVICE_ID = 4;
const RTU_REGISTER_ADDRESS = 1;

// Создаем Express сервер для веб-интерфейса
const webApp = express();
webApp.use(express.static('public'));

// Создаем OPC UA сервер
const server = new opcua.OPCUAServer({
    port: OPC_UA_PORT,
    resourcePath: "/UA/MyServer",
    buildInfo: {
        productName: "Modbus-OPC-UA-Bridge",
        buildNumber: "1.0.0"
    }
});

let currentValue = 0.0;
let rtuValue = 0.0;
let modbusClient = null;
let modbusRTUClient = null;
let isModbusConnected = false;
let isModbusRTUConnected = false;

// Маршрут для API получения значений
webApp.get('/api/values', (req, res) => {
    res.json({
        tcpValue: currentValue,
        rtuValue: rtuValue,
        timestamp: new Date().toISOString()
    });
});

webApp.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function main() {
    try {
        // Запускаем веб-сервер
        webApp.listen(WEB_PORT, () => {
            console.log(`Веб-интерфейс доступен по адресу: http://localhost:${WEB_PORT}`);
        });

        // Инициализация OPC UA сервера
        await server.initialize();
        console.log("OPC UA сервер инициализирован");

        // Создаем адресное пространство
        const addressSpace = server.engine.addressSpace;
        const namespace = addressSpace.getOwnNamespace();

        // Создаем папку для нашего устройства
        const deviceFolder = namespace.addFolder(addressSpace.rootFolder.objects, {
            browseName: "ModbusDevices"
        });

        // Создаем объект для TCP устройства
        const tcpDevice = namespace.addObject({
            organizedBy: deviceFolder,
            browseName: "TCP_Device_1"
        });

        // Создаем объект для RTU устройства
        const rtuDevice = namespace.addObject({
            organizedBy: deviceFolder,
            browseName: "RTU_Device_4"
        });

        // Добавляем переменную для TCP
        namespace.addVariable({
            componentOf: tcpDevice,
            browseName: "Tag97",
            nodeId: "s=TemperatureSensor_TCP",
            dataType: "Float",
            value: {
                get: () => new opcua.Variant({
                    dataType: opcua.DataType.Float,
                    value: currentValue
                })
            },
            minimumSamplingInterval: 1000
        });

        // Добавляем переменную для RTU
        namespace.addVariable({
            componentOf: rtuDevice,
            browseName: "Register1",
            nodeId: "s=RTU_Register_1",
            dataType: "UInt16",
            value: {
                get: () => new opcua.Variant({
                    dataType: opcua.DataType.UInt16,
                    value: rtuValue
                })
            },
            minimumSamplingInterval: 1000
        });

        console.log("Переменные созданы успешно");

        // Запускаем сервер
        await server.start();
        console.log(`OPC UA сервер запущен на порту ${OPC_UA_PORT}`);
        console.log(`Endpoint URL: ${server.endpoints[0].endpointDescriptions()[0].endpointUrl}`);

        // Подключаемся к Modbus TCP и RTU
        initializeModbusConnections();
        startModbusPolling();

    } catch (error) {
        console.error("Ошибка:", error);
    }
}

function initializeModbusConnections() {
    // Инициализация TCP клиента
    modbusClient = new ModbusRTU();
    
    modbusClient.on("error", (error) => {
        console.error("Modbus TCP ошибка:", error.message);
        isModbusConnected = false;
    });

    modbusClient.on("close", () => {
        console.log("Modbus TCP соединение закрыто");
        isModbusConnected = false;
    });

    // Инициализация RTU клиента
    modbusRTUClient = new ModbusRTU();
    
    modbusRTUClient.on("error", (error) => {
        console.error("Modbus RTU ошибка:", error.message);
        isModbusRTUConnected = false;
    });

    modbusRTUClient.on("close", () => {
        console.log("Modbus RTU соединение закрыто");
        isModbusRTUConnected = false;
    });
}

async function connectToModbusTCP() {
    if (isModbusConnected) return true;

    try {
        await modbusClient.connectTCP(MODBUS_IP, { port: MODBUS_PORT });
        modbusClient.setID(DEVICE_ID);
        isModbusConnected = true;
        console.log(`Подключено к Modbus TCP устройству ${MODBUS_IP}:${MODBUS_PORT}, ID: ${DEVICE_ID}`);
        return true;
    } catch (error) {
        console.error("Ошибка подключения к Modbus TCP:", error.message);
        isModbusConnected = false;
        return false;
    }
}

async function connectToModbusRTU() {
    if (isModbusRTUConnected) return true;

    try {
        await modbusRTUClient.connectRTUBuffered(COM_PORT, {
            baudRate: BAUD_RATE,
            dataBits: 8,
            stopBits: 1,
            parity: 'none'
        });
        modbusRTUClient.setID(RTU_DEVICE_ID);
        isModbusRTUConnected = true;
        console.log(`Подключено к Modbus RTU устройству ${COM_PORT}, ID: ${RTU_DEVICE_ID}`);
        return true;
    } catch (error) {
        console.error("Ошибка подключения к Modbus RTU:", error.message);
        isModbusRTUConnected = false;
        return false;
    }
}

async function readModbusTCPData() {
    if (!isModbusConnected) {
        const connected = await connectToModbusTCP();
        if (!connected) return;
    }

    try {
        const data = await modbusClient.readHoldingRegisters(TAG_ADDRESS, 2);
        if (data && data.data && data.data.length >= 2) {
            // Конвертируем в float (big-endian)
            const buffer = Buffer.alloc(4);
            buffer.writeUInt16BE(data.data[0], 0);
            buffer.writeUInt16BE(data.data[1], 2);
            currentValue = buffer.readFloatBE(0);
            console.log(`Новое значение TCP Tag97: ${currentValue}`);
        }
    } catch (error) {
        console.error("Ошибка чтения Modbus TCP:", error.message);
        isModbusConnected = false;
        
        // Закрываем соединение при ошибке
        try {
            await modbusClient.close();
        } catch (closeError) {
            // Игнорируем ошибки закрытия
        }
    }
}

async function readModbusRTUData() {
    if (!isModbusRTUConnected) {
        const connected = await connectToModbusRTU();
        if (!connected) return;
    }

    try {
        const data = await modbusRTUClient.readHoldingRegisters(RTU_REGISTER_ADDRESS, 1);
        if (data && data.data && data.data.length >= 1) {
            rtuValue = data.data[0];
            console.log(`Новое значение RTU Register ${RTU_REGISTER_ADDRESS}: ${rtuValue}`);
        }
    } catch (error) {
        console.error("Ошибка чтения Modbus RTU:", error.message);
        isModbusRTUConnected = false;
        
        // Закрываем соединение при ошибке
        try {
            await modbusRTUClient.close();
        } catch (closeError) {
            // Игнорируем ошибки закрытия
        }
    }
}

function startModbusPolling() {
    // Пытаемся подключиться сразу
    connectToModbusTCP().then(connected => {
        if (connected) {
            readModbusTCPData();
        }
    });

    connectToModbusRTU().then(connected => {
        if (connected) {
            readModbusRTUData();
        }
    });

    // Запускаем периодический опрос TCP
    setInterval(() => {
        readModbusTCPData();
    }, 2000);

    // Запускаем периодический опрос RTU
    setInterval(() => {
        readModbusRTUData();
    }, 2000);
}

// Обработка завершения
process.on("SIGINT", async () => {
    console.log("Остановка сервера...");
    
    // Закрываем Modbus соединения
    if (modbusClient) {
        try {
            await modbusClient.close();
            console.log("Modbus TCP соединение закрыто");
        } catch (error) {
            console.error("Ошибка при закрытии Modbus TCP:", error.message);
        }
    }
    
    if (modbusRTUClient) {
        try {
            await modbusRTUClient.close();
            console.log("Modbus RTU соединение закрыто");
        } catch (error) {
            console.error("Ошибка при закрытии Modbus RTU:", error.message);
        }
    }
    
    // Останавливаем OPC UA сервер
    await server.shutdown();
    console.log("Сервер остановлен");
    process.exit(0);
});

process.on("unhandledRejection", (error) => {
    console.error("Необработанная ошибка:", error);
});

main().catch(error => {
    console.error("Критическая ошибка при запуске:", error);
    process.exit(1);
});