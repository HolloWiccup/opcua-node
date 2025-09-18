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
let modbusClient = null;
let isModbusConnected = false;

// Маршрут для API получения значения
webApp.get('/api/value', (req, res) => {
    res.json({
        value: currentValue,
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

        // Создаем объект устройства
        const device = namespace.addObject({
            organizedBy: deviceFolder,
            browseName: "Device_1"
        });

        // Добавляем переменную
        namespace.addVariable({
            componentOf: device,
            browseName: "Tag97",
            nodeId: "s=TemperatureSensor_1",
            dataType: "Float",
            value: {
                get: () => new opcua.Variant({
                    dataType: opcua.DataType.Float,
                    value: currentValue
                })
            },
            minimumSamplingInterval: 1000
        });

        console.log("Переменная Tag97 создана успешно");

        // Запускаем сервер
        await server.start();
        console.log(`OPC UA сервер запущен на порту ${OPC_UA_PORT}`);
        console.log(`Endpoint URL: ${server.endpoints[0].endpointDescriptions()[0].endpointUrl}`);

        // Подключаемся к Modbus и запускаем опрос
        initializeModbusConnection();
        startModbusPolling();

    } catch (error) {
        console.error("Ошибка:", error);
    }
}

function initializeModbusConnection() {
    modbusClient = new ModbusRTU();
    
    modbusClient.on("error", (error) => {
        console.error("Modbus ошибка:", error.message);
        isModbusConnected = false;
    });

    modbusClient.on("close", () => {
        console.log("Modbus соединение закрыто");
        isModbusConnected = false;
    });
}

async function connectToModbus() {
    if (isModbusConnected) return true;

    try {
        await modbusClient.connectTCP(MODBUS_IP, { port: MODBUS_PORT });
        modbusClient.setID(DEVICE_ID);
        isModbusConnected = true;
        console.log(`Подключено к Modbus устройству ${MODBUS_IP}:${MODBUS_PORT}, ID: ${DEVICE_ID}`);
        return true;
    } catch (error) {
        console.error("Ошибка подключения к Modbus:", error.message);
        isModbusConnected = false;
        return false;
    }
}




async function readModbusData() {
    if (!isModbusConnected) {
        const connected = await connectToModbus();
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
            console.log(`Новое значение Tag97: ${currentValue}`);
        }
    } catch (error) {
        console.error("Ошибка чтения Modbus:", error.message);
        isModbusConnected = false;
        
        // Закрываем соединение при ошибке
        try {
            await modbusClient.close();
        } catch (closeError) {
            // Игнорируем ошибки закрытия
        }
    }
}

function startModbusPolling() {
    // Пытаемся подключиться сразу
    connectToModbus().then(connected => {
        if (connected) {
            readModbusData();
        }
    });

    // Запускаем периодический опрос
    setInterval(() => {
        readModbusData();
    }, 2000);
}

// Обработка завершения
process.on("SIGINT", async () => {
    console.log("Остановка сервера...");
    
    // Закрываем Modbus соединение
    if (modbusClient) {
        try {
            await modbusClient.close();
            console.log("Modbus соединение закрыто");
        } catch (error) {
            console.error("Ошибка при закрытии Modbus:", error.message);
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